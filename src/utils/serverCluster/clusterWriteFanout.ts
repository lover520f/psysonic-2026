import { apiForServer } from '../../api/subsonicClient';
import { libraryClusterResolveCandidates } from '../../api/library';
import { patchLibraryTrackOnUse } from '../library/patchOnUse';
import { resolveClusterBrowseMembers } from './clusterBrowse';
import { getActiveCluster, isClusterMode } from './clusterScope';

async function allCandidateTrackIds(
  browseServerId: string,
  trackId: string,
): Promise<Array<{ serverId: string; trackId: string }>> {
  const members = await resolveClusterBrowseMembers();
  if (!members) return [{ serverId: browseServerId, trackId }];
  try {
    const resp = await libraryClusterResolveCandidates({
      serversOrdered: members,
      serverId: browseServerId,
      trackId,
    });
    return resp.candidates.map(c => ({ serverId: c.serverId, trackId: c.trackId }));
  } catch {
    return [{ serverId: browseServerId, trackId }];
  }
}

/** Fan-out scrobble submission=true per cluster settings (spec §7.2). */
export async function clusterFanOutScrobbleSubmission(
  browseServerId: string,
  trackId: string,
  time: number,
): Promise<void> {
  if (!isClusterMode()) return;
  const cluster = getActiveCluster();
  const syncAll = cluster?.clusterSyncPlayCounts ?? true;
  const targets = await allCandidateTrackIds(browseServerId, trackId);
  const toWrite = syncAll ? targets : targets.slice(0, 1);
  await Promise.allSettled(
    toWrite.map(async ({ serverId, trackId: tid }) => {
      await apiForServer(serverId, 'scrobble.view', { id: tid, submission: true, time });
      patchLibraryTrackOnUse(serverId, tid, { playedAt: time });
    }),
  );
}

/** Fan-out star/unstar to all cluster members holding the track (spec §7.1). */
export async function clusterFanOutStar(
  browseServerId: string,
  trackId: string,
  star: boolean,
): Promise<void> {
  if (!isClusterMode()) return;
  const targets = await allCandidateTrackIds(browseServerId, trackId);
  await Promise.allSettled(
    targets.map(async ({ serverId, trackId: tid }) => {
      const params = { id: tid };
      await apiForServer(serverId, star ? 'star.view' : 'unstar.view', params);
      patchLibraryTrackOnUse(serverId, tid, { starredAt: star ? Date.now() : null });
    }),
  );
}

/** Fan-out rating to all cluster members holding the track. */
export async function clusterFanOutRating(
  browseServerId: string,
  trackId: string,
  rating: number,
): Promise<void> {
  if (!isClusterMode()) return;
  const targets = await allCandidateTrackIds(browseServerId, trackId);
  await Promise.allSettled(
    targets.map(async ({ serverId, trackId: tid }) => {
      await apiForServer(serverId, 'setRating.view', { id: tid, rating });
      patchLibraryTrackOnUse(serverId, tid, { userRating: rating });
    }),
  );
}
