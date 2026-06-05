import { reportNowPlaying } from '../api/subsonicScrobble';
import { invoke } from '@tauri-apps/api/core';
import { lastfmGetTrackLoved, lastfmUpdateNowPlaying } from '../api/lastfm';
import { setDeferHotCachePrefetch } from '../utils/cache/hotCacheGate';
import { orbitBulkGuard } from '../utils/orbitBulkGuard';
import { sameQueueTrackId } from '../utils/playback/queueIdentity';
import {
  bindQueueServerForPlayback,
  getPlaybackCacheServerKey,
  getPlaybackIndexKey,
  getPlaybackServerId,
  shouldBindQueueServerForPlay,
} from '../utils/playback/playbackServer';
import { resolvePlaybackUrl } from '../utils/playback/resolvePlaybackUrl';
import { resolveReplayGainDb } from '../utils/audio/resolveReplayGainDb';
import { useAuthStore } from './authStore';
import {
  bumpPlayGeneration,
  getPlayGeneration,
  setIsAudioPaused,
} from './engineState';
import {
  clearPreloadingIds,
  getLastGaplessSwitchTime,
} from './gaplessPreloadState';
import { touchHotCacheOnPlayback } from './hotCacheTouch';
import {
  isReplayGainActive,
  loudnessGainDbForEngineBind,
} from './loudnessGainCache';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import { deriveNormalizationSnapshot } from './normalizationSnapshot';
import { useOrbitStore } from './orbitStore';
import {
  playbackSourceHintForResolvedUrl,
  recordEnginePlayUrl,
} from './playbackUrlRouting';
import type { PlayerState, Track } from './playerStoreTypes';
import { toQueueItemRefs } from '../utils/library/queueItemRef';
import { getQueueTracksView, resolveQueueTrack } from '../utils/library/queueTrackView';
import { seedQueueResolver } from '../utils/library/queueTrackResolver';
import { promoteCompletedStreamToHotCache } from './promoteStreamCache';
import { syncQueueToServer } from './queueSync';
import { playListenSessionFinalize } from './playListenSession';
import { pushQueueUndoFromGetter } from './queueUndo';
import { stopRadio } from './radioPlayer';
import { clearAllPlaybackScheduleTimers } from './scheduleTimers';
import { clearSeekDebounce } from './seekDebounce';
import {
  clearSeekFallbackRetry,
  getSeekFallbackVisualTarget,
  setSeekFallbackRestartAt,
  setSeekFallbackTrackId,
  setSeekFallbackVisualTarget,
} from './seekFallbackState';
import {
  clearSeekTarget,
  setSeekTarget,
} from './seekTargetState';
import { refreshWaveformForTrack } from './waveformRefresh';
import { isClusterMode } from '../utils/serverCluster/clusterScope';
import {
  cascadeClusterPlayback,
  resolveClusterPlaybackForTrack,
} from '../utils/serverCluster/clusterPlaybackResolve';
import { resolveServerIdForIndexKey } from '../utils/server/serverLookup';
import { serverIndexKeyForProfile } from '../utils/server/serverIndexKey';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Play a track, optionally replacing the queue and/or jumping to an
 * explicit slot. Three guard layers run before the actual play body:
 *
 * 1. **Orbit bulk-gate** — when `queue.length > 1` and isn't a no-op
 *    replace of the current queue, prompt via `orbitBulkGuard`; on
 *    confirm, hosts/guests append (Orbit semantics — bulk replace
 *    would drop guest suggestions) and non-Orbit users replace as
 *    normal.
 * 2. **Orbit-host single-track protection** — a `playTrack(track,
 *    [track])` from a host would blow away the shared queue; re-route
 *    to append-and-jump so guest suggestions survive.
 * 3. **Ghost-command guard** — a playTrack arriving within 500 ms of
 *    the last gapless switch is almost certainly a stale IPC echo.
 *
 * The play body itself: clears all scheduled timers + seek state,
 * resolves the URL, updates store + normalization snapshot
 * optimistically, invokes the Rust engine, and on success seeks to
 * the visual target if there was a pending one. Falls back to
 * `next(false)` 500 ms after an `audio_play` failure. Same-track
 * replays first flush the previous play's `stream_completed_cache`
 * to hot disk so `fetch_data` doesn't re-run an HTTP range request.
 */
export function runPlayTrack(
  set: SetState,
  get: GetState,
  track: Track,
  queue: Track[] | undefined,
  manual: boolean,
  _orbitConfirmed: boolean,
  targetQueueIndex: number | undefined,
): void {
  // Orbit bulk-gate: only gate when the `queue` argument *replaces*
  // the current queue (Play All / Play Album / Play Playlist / Hero
  // play buttons). Navigation calls — queue-row click, next(),
  // previous() — pass the existing queue back through playTrack just
  // to move the index; they are not bulk operations and must not
  // trigger the confirm dialog (#234 regression).
  if (!_orbitConfirmed && queue && queue.length > 1) {
    const current = get().queueItems;
    const sameAsCurrent = queue.length === current.length
      && queue.every((t, i) => sameQueueTrackId(current[i]?.trackId, t.id));
    if (!sameAsCurrent) {
      void orbitBulkGuard(queue.length).then(ok => {
        if (!ok) return;
        // Inside an Orbit session a bulk replace would discard guest
        // suggestions mid-listen. Append instead — the dialog's
        // "Add them all" copy already matches that semantic. Outside
        // Orbit, proceed as a normal replace.
        const role = useOrbitStore.getState().role;
        if (role === 'host' || role === 'guest') {
          get().enqueue(queue, true);
        } else {
          get().playTrack(track, queue, manual, true);
        }
      });
      return;
    }
  }

  // Orbit-host single-track protection. The host's `playerStore.queue`
  // *is* the shared Orbit queue. A `playTrack(track, [track])` call
  // (e.g. OfflineLibrary's "Play this album" on a single-track album,
  // or any other surface that explicitly passes a 1-track replacement
  // queue) would otherwise blow away every guest suggestion + every
  // upcoming track. Re-route to append + jump so the queue survives.
  // Guest stays unguarded — a guest clicking Play locally is choosing
  // to opt out of host-sync, which is the existing "guest is running
  // their own show" path. `useOrbitGuest`'s `syncToHost` is also a
  // guest-only call site, so it's never intercepted here.
  if (!_orbitConfirmed && queue && queue.length === 1) {
    const orbitRole = useOrbitStore.getState().role;
    if (orbitRole === 'host') {
      const currentItems = get().queueItems;
      const currentTrackId = currentItems[get().queueIndex]?.trackId;
      if (track.id !== currentTrackId) {
        const existsAt = currentItems.findIndex(r => sameQueueTrackId(r.trackId, track.id));
        if (existsAt >= 0) {
          // Re-jump within the existing queue: pass undefined so playTrack keeps
          // the canonical queueItems and just moves the index.
          get().playTrack(track, undefined, manual, true, existsAt);
        } else {
          // Append the single track to the resolved current queue and jump to it.
          const newQueue = [...getQueueTracksView(currentItems), track];
          get().playTrack(track, newQueue, manual, true, newQueue.length - 1);
        }
        return;
      }
    }
  }

  // Ghost-command guard: if a gapless switch happened within 500 ms,
  // this playTrack call is likely a stale IPC echo — suppress it.
  if (Date.now() - getLastGaplessSwitchTime() < 500) {
    return;
  }

  void playListenSessionFinalize('skip');

  clearAllPlaybackScheduleTimers();
  set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });

  const gen = bumpPlayGeneration();
  setIsAudioPaused(false);
  clearPreloadingIds(); // new track — allow fresh preload for next
  clearSeekDebounce(); clearSeekTarget();
  clearSeekFallbackRetry();
  setSeekFallbackRestartAt(0);

  // If a radio stream is active, stop it before the new track starts so
  // the PlayerBar clears radio mode immediately and the stream is released.
  if (get().currentRadio) {
    stopRadio();
  }

  const state = get();
  const prevTrack = state.currentTrack;
  if (prevTrack?.id !== track.id) {
    setSeekFallbackTrackId(null);
  }
  const visualOnEntry = getSeekFallbackVisualTarget();
  if (visualOnEntry?.trackId !== track.id) {
    setSeekFallbackVisualTarget(null);
  }
  // Thin-state: only a real queue *replacement* (explicit `queue` arg) rebuilds
  // queueItems. A no-arg navigation (next/previous/queue-row jump) keeps the
  // canonical refs and just moves the index — so we never resolve the whole
  // queue here (O(visible), not O(queue length)), which would hitch + churn
  // every subscriber on each track change at scale.
  const replacing = queue !== undefined;
  const srcLen = replacing ? queue.length : state.queueItems.length;
  if (replacing && shouldBindQueueServerForPlay(state.queueItems, queue, queue)) {
    bindQueueServerForPlayback();
  }
  // Prefer an explicit target index from the caller (next/previous/queue-row
  // click already know the exact slot). `findIndex` returns the *first*
  // matching id, which jumps backwards when the queue contains the same
  // track twice — breaking radio playback (issue #500).
  const matchesAt = (i: number): boolean =>
    replacing
      ? sameQueueTrackId(queue[i]?.id, track.id)
      : sameQueueTrackId(state.queueItems[i]?.trackId, track.id);
  const explicitIdxValid =
    typeof targetQueueIndex === 'number'
    && targetQueueIndex >= 0
    && targetQueueIndex < srcLen
    && matchesAt(targetQueueIndex);
  const idx = explicitIdxValid
    ? (targetQueueIndex as number)
    : replacing
      ? queue.findIndex(t => sameQueueTrackId(t.id, track.id))
      : state.queueItems.findIndex(r => sameQueueTrackId(r.trackId, track.id));
  const playIdx = idx >= 0 ? idx : 0;
  // ±1 neighbours for replaygain normalization — resolve only these (not the
  // whole queue). On replace they come from the provided Track[]; on navigation
  // from the resolver cache (the bridge keeps that window warm).
  const neighbourAt = (i: number): Track | null => {
    if (i < 0 || i >= srcLen) return null;
    if (replacing) return queue[i] ?? null;
    if (i === playIdx) return track;
    const ref = state.queueItems[i];
    return ref ? resolveQueueTrack(ref) : null;
  };
  const prevNeighbour = neighbourAt(playIdx - 1);
  const nextNeighbour = neighbourAt(playIdx + 1);
  // Minimal window so deriveNormalizationSnapshot reads ±1 without a full array.
  const normWindow: Track[] = prevNeighbour ? [prevNeighbour] : [];
  const normIdx = normWindow.length;
  normWindow.push(track);
  if (nextNeighbour) normWindow.push(nextNeighbour);
  if (manual) {
    pushQueueUndoFromGetter(get);
  }
  const visualForInitial = getSeekFallbackVisualTarget();
  const pendingVisualTarget = visualForInitial?.trackId === track.id
    ? visualForInitial.seconds
    : null;
  const initialTime = pendingVisualTarget !== null
    ? Math.max(0, Math.min(pendingVisualTarget, track.duration || pendingVisualTarget))
    : 0;
  const initialProgress =
    track.duration && track.duration > 0 ? Math.max(0, Math.min(1, initialTime / track.duration)) : 0;

  const authState = useAuthStore.getState();
  // Same-track replay: Rust `fetch_data` consumes `stream_completed_cache` with
  // `take()` once; a second replay would full HTTP-range again unless we flush
  // RAM to hot disk first (promote was only run when switching to another track).
  const needSameTrackHotPromote =
    Boolean(
      prevTrack
      && sameQueueTrackId(prevTrack.id, track.id)
      && authState.hotCacheEnabled
      && getPlaybackCacheServerKey(),
    );

  const browseServerId = authState.activeServerId ?? '';
  const browseTrackId = track.id;

  void (async () => {
    let playTrackResolved = track;
    let streamServerProfileId = '';

    if (isClusterMode() && browseServerId) {
      const resolved = await resolveClusterPlaybackForTrack(browseServerId, track.id);
      if (resolved) {
        playTrackResolved = { ...track, id: resolved.trackId };
        streamServerProfileId = resolved.serverId;
      }
    }

    const runPlayTrackBody = () => {
    const authStateNow = useAuthStore.getState();
    const stateNow = get();
    const refAtIdx = stateNow.queueItems[playIdx];
    const refServerProfile =
      streamServerProfileId
      || (refAtIdx ? resolveServerIdForIndexKey(refAtIdx.serverId) : '')
      || getPlaybackServerId();
    const refServer = authStateNow.servers.find(s => s.id === refServerProfile);
    const playbackCacheSid = refServer
      ? serverIndexKeyForProfile(refServer) || refServerProfile
      : getPlaybackCacheServerKey();
    const url = resolvePlaybackUrl(playTrackResolved.id, playbackCacheSid);
    recordEnginePlayUrl(playTrackResolved.id, url);
    const preloadedTrackId = get().enginePreloadedTrackId;
    const keepPreloadHint = preloadedTrackId === playTrackResolved.id;
    const playbackSourceHint = playbackSourceHintForResolvedUrl(
      playTrackResolved.id,
      playbackCacheSid,
      url,
    );
    if (import.meta.env.DEV) {
      console.info('[psysonic][playTrack-source]', {
        trackId: playTrackResolved.id,
        resolvedUrl: url,
        preloadedTrackId,
        keepPreloadHint,
        playbackSourceHint,
      });
    }

    const queueSid = get().queueServerId ?? '';
    if (queue && queueSid) seedQueueResolver(queueSid, queue);
    const queuePatch =
      streamServerProfileId && refAtIdx
        ? {
            queueItems: stateNow.queueItems.map((r, i) =>
              i === playIdx
                ? {
                    ...r,
                    serverId: serverIndexKeyForProfile(refServer!) || streamServerProfileId,
                    trackId: playTrackResolved.id,
                  }
                : r,
            ),
          }
        : replacing
          ? { queueItems: toQueueItemRefs(queueSid, queue) }
          : {};
    set({
      currentTrack: playTrackResolved,
      currentRadio: null,
      waveformBins: null,
      ...deriveNormalizationSnapshot(playTrackResolved, normWindow, normIdx),
      ...queuePatch,
      queueIndex: idx >= 0 ? idx : 0,
      progress: initialProgress,
      buffered: 0,
      currentTime: initialTime,
      scrobbled: false,
      lastfmLoved: false,
      isPlaying: playbackSourceHint !== 'stream',
      isPlaybackBuffering: playbackSourceHint === 'stream',
      currentPlaybackSource: playbackSourceHint,
      enginePreloadedTrackId: keepPreloadHint ? playTrackResolved.id : null,
    });

    if (
      prevTrack
      && !sameQueueTrackId(prevTrack.id, playTrackResolved.id)
      && authStateNow.hotCacheEnabled
    ) {
      const prevPromoteSid = getPlaybackCacheServerKey();
      if (prevPromoteSid) {
        void promoteCompletedStreamToHotCache(
          prevTrack,
          prevPromoteSid,
          authStateNow.hotCacheDownloadDir || null,
        );
      }
    }
    void refreshWaveformForTrack(playTrackResolved.id);
    void refreshLoudnessForTrack(playTrackResolved.id);
    setDeferHotCachePrefetch(true);
    const replayGainDb = resolveReplayGainDb(
      playTrackResolved, prevTrack, nextNeighbour,
      isReplayGainActive(), authStateNow.replayGainMode,
    );
    const replayGainPeak = isReplayGainActive() ? (playTrackResolved.replayGainPeak ?? null) : null;
    invoke('audio_play', {
      url,
      volume: state.volume,
      durationHint: playTrackResolved.duration,
      replayGainDb,
      replayGainPeak,
      loudnessGainDb: loudnessGainDbForEngineBind(playTrackResolved.id),
      preGainDb: authStateNow.replayGainPreGainDb,
      fallbackDb: authStateNow.replayGainFallbackDb,
      manual,
      hiResEnabled: authStateNow.enableHiRes,
      analysisTrackId: playTrackResolved.id,
      serverId: playbackCacheSid || null,
      streamFormatSuffix: playTrackResolved.suffix ?? null,
    })
      .then(() => {
        if (getPlayGeneration() !== gen) return;
        if (keepPreloadHint) {
          set({ enginePreloadedTrackId: null });
        }
        const durSeek = playTrackResolved.duration && playTrackResolved.duration > 0
          ? playTrackResolved.duration
          : null;
        const seekTo = initialTime;
        const canSeekAfterPlay =
          seekTo > 0.05 && (durSeek == null || seekTo < durSeek - 0.05);
        if (canSeekAfterPlay) {
          void invoke('audio_seek', { seconds: seekTo })
            .then(() => {
              if (getPlayGeneration() !== gen) return;
              setSeekTarget(seekTo);
              if (getSeekFallbackVisualTarget()?.trackId === playTrackResolved.id) {
                setSeekFallbackVisualTarget(null);
              }
            })
            .catch(() => {
              if (getSeekFallbackVisualTarget()?.trackId === playTrackResolved.id) {
                setSeekFallbackVisualTarget(null);
              }
            });
        }
      })
      .catch((err: unknown) => {
        if (getPlayGeneration() !== gen) return;
        if (isClusterMode() && browseServerId && refServerProfile) {
          void cascadeClusterPlayback(browseServerId, browseTrackId, refServerProfile).then(next => {
            if (!next || getPlayGeneration() !== gen) {
              setDeferHotCachePrefetch(false);
              set({ isPlaying: false });
              setTimeout(() => {
                if (getPlayGeneration() !== gen) return;
                get().next(false);
              }, 500);
              return;
            }
            playTrackResolved = { ...playTrackResolved, id: next.trackId };
            streamServerProfileId = next.serverId;
            runPlayTrackBody();
          });
          return;
        }
        setDeferHotCachePrefetch(false);
        console.error('[psysonic] audio_play failed:', err);
        set({ isPlaying: false });
        setTimeout(() => {
          if (getPlayGeneration() !== gen) return;
          get().next(false);
        }, 500);
      });

    const { nowPlayingEnabled: npEnabled, scrobblingEnabled: lfmEnabled, lastfmSessionKey: lfmKey } = useAuthStore.getState();
    if (npEnabled) reportNowPlaying(playTrackResolved.id, refServerProfile || getPlaybackServerId());
    if (lfmKey) {
      if (lfmEnabled) lastfmUpdateNowPlaying(playTrackResolved, lfmKey);
      lastfmGetTrackLoved(playTrackResolved.title, playTrackResolved.artist, lfmKey).then(loved => {
        const cacheKey = `${playTrackResolved.title}::${playTrackResolved.artist}`;
        set(s => ({
          lastfmLoved: loved,
          lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: loved },
        }));
      });
    }
    syncQueueToServer(get().queueItems, playTrackResolved, initialTime);
    touchHotCacheOnPlayback(playTrackResolved.id, playbackCacheSid);
  };

    const hotPromoteSid = getPlaybackCacheServerKey();
    if (needSameTrackHotPromote && hotPromoteSid) {
      void promoteCompletedStreamToHotCache(
        track,
        hotPromoteSid,
        authState.hotCacheDownloadDir || null,
      )
        .then(() => {
          if (getPlayGeneration() !== gen) return;
          runPlayTrackBody();
        })
        .catch((err: unknown) => {
          if (getPlayGeneration() !== gen) return;
          setDeferHotCachePrefetch(false);
          console.error('[psysonic] same-track hot promote / play body failed:', err);
          set({ isPlaying: false });
        });
    } else {
      runPlayTrackBody();
    }
  })();
}
