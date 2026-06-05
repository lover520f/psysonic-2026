/**
 * Mid-session cascade when the streaming member becomes unavailable (spec §6).
 */
import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';
import { resolveServerIdForIndexKey } from '../server/serverLookup';
import { isServerLikelyReachable } from './representative';
import { cascadeClusterPlayback } from './clusterPlaybackResolve';
import { isClusterMode } from './clusterScope';

export function useClusterPlaybackMonitor(): void {
  const activeClusterId = useAuthStore(s => s.activeClusterId);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const queueItems = usePlayerStore(s => s.queueItems);
  const lastCheck = useRef(0);

  useEffect(() => {
    if (!isClusterMode() || !activeClusterId || !isPlaying || !currentTrack) return;

    const tick = () => {
      const now = Date.now();
      if (now - lastCheck.current < 3000) return;
      lastCheck.current = now;
      const st = usePlayerStore.getState();
      const ref = st.queueItems[st.queueIndex];
      if (!ref) return;
      const streamSid = resolveServerIdForIndexKey(ref.serverId);
      if (isServerLikelyReachable(streamSid)) return;

      const browseId = useAuthStore.getState().activeServerId ?? streamSid;
      void cascadeClusterPlayback(browseId, ref.trackId, streamSid).then(next => {
        if (!next) {
          usePlayerStore.getState().next(false);
          return;
        }
        const track = st.currentTrack;
        if (!track) return;
        usePlayerStore.getState().playTrack(
          { ...track, id: next.trackId, clusterBrowseServerId: next.serverId },
          undefined,
          false,
          true,
          st.queueIndex,
        );
      });
    };

    const id = window.setInterval(tick, 4000);
    return () => window.clearInterval(id);
  }, [activeClusterId, isPlaying, currentTrack?.id, queueIndex, queueItems.length]);
}
