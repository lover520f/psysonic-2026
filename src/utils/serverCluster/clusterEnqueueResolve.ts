import type { QueueItemRef, Track } from '../../store/playerStoreTypes';
import { useAuthStore } from '../../store/authStore';
import { resolveServerIdForIndexKey } from '../server/serverLookup';
import { toQueueItemRefs, toQueueItemRefsMulti } from '../library/queueItemRef';
import { isClusterMode } from './clusterScope';
import { resolveClusterPlaybackForTrack } from './clusterPlaybackResolve';

/** Resolve merged tracks to concrete server refs for enqueue (spec §6). */
export async function resolveTracksForClusterEnqueue(
  tracks: Track[],
  browseServerId: string,
): Promise<Array<{ serverId: string; track: Track }>> {
  if (!isClusterMode() || tracks.length === 0) {
    const sid = browseServerId || useAuthStore.getState().activeServerId || '';
    return tracks.map(track => ({ serverId: sid, track }));
  }
  const fallback = browseServerId || useAuthStore.getState().activeServerId || '';
  const out: Array<{ serverId: string; track: Track }> = [];
  for (const track of tracks) {
    const seedServer = track.clusterBrowseServerId ?? fallback;
    const resolved = await resolveClusterPlaybackForTrack(seedServer, track.id);
    if (resolved) {
      out.push({
        serverId: resolved.serverId,
        track: { ...track, id: resolved.trackId, clusterBrowseServerId: resolved.serverId },
      });
    } else {
      out.push({ serverId: seedServer, track });
    }
  }
  return out;
}

export async function clusterAwareQueueRefs(
  tracks: Track[],
  browseServerId: string,
): Promise<QueueItemRef[]> {
  if (!isClusterMode()) {
    return toQueueItemRefs(browseServerId, tracks);
  }
  const resolved = await resolveTracksForClusterEnqueue(tracks, browseServerId);
  return toQueueItemRefsMulti(resolved);
}
