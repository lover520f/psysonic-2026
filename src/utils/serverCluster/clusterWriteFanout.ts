/**
 * Cluster write fan-out with resolved-server targeting and failure toasts (spec §7).
 */
import { apiForServer } from '../../api/subsonicClient';
import { libraryClusterResolveCandidates } from '../../api/library';
import { patchLibraryTrackOnUse } from '../library/patchOnUse';
import { serverListDisplayLabel } from '../server/serverDisplayName';
import { showToast } from '../ui/toast';
import { resolveClusterBrowseMembers } from './clusterBrowse';
import { getActiveCluster, isClusterMode } from './clusterScope';
import { useAuthStore } from '../../store/authStore';
import i18n from '../../i18n';

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

function toastFanOutFailures(
  action: 'star' | 'rating' | 'scrobble',
  failures: Array<{ serverId: string; reason: unknown }>,
): void {
  if (failures.length === 0) return;
  const servers = useAuthStore.getState().servers;
  const names = failures
    .map(f => {
      const server = servers.find(s => s.id === f.serverId);
      return server ? serverListDisplayLabel(server, servers) : f.serverId;
    })
    .filter(Boolean)
    .join(', ');
  const key =
    action === 'star' ? 'cluster.fanOutStarFailed'
    : action === 'rating' ? 'cluster.fanOutRatingFailed'
    : 'cluster.fanOutScrobbleFailed';
  showToast(i18n.t(key, { servers: names || failures.length }), 5000, 'error');
}

async function fanOutWithToast(
  action: 'star' | 'rating' | 'scrobble',
  targets: Array<{ serverId: string; trackId: string }>,
  run: (serverId: string, trackId: string) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    targets.map(({ serverId, trackId }) => run(serverId, trackId)),
  );
  const failures: Array<{ serverId: string; reason: unknown }> = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') failures.push({ serverId: targets[i]!.serverId, reason: r.reason });
  });
  toastFanOutFailures(action, failures);
}

/** Fan-out scrobble submission=true per cluster settings (spec §7.2). */
export async function clusterFanOutScrobbleSubmission(
  browseServerId: string,
  trackId: string,
  time: number,
  resolvedServerId?: string,
): Promise<void> {
  if (!isClusterMode()) return;
  const cluster = getActiveCluster();
  const syncAll = cluster?.clusterSyncPlayCounts ?? true;
  const targets = await allCandidateTrackIds(browseServerId, trackId);
  const playing = resolvedServerId ?? browseServerId;
  const match = targets.find(t => t.serverId === playing);
  const toWrite = syncAll ? targets : (match ? [match] : targets.slice(0, 1));
  await fanOutWithToast('scrobble', toWrite, async (serverId, tid) => {
    await apiForServer(serverId, 'scrobble.view', { id: tid, submission: true, time });
    patchLibraryTrackOnUse(serverId, tid, { playedAt: time });
  });
}

/** Fan-out star/unstar to all cluster members holding the track (spec §7.1). */
export async function clusterFanOutStar(
  browseServerId: string,
  trackId: string,
  star: boolean,
): Promise<void> {
  if (!isClusterMode()) return;
  const targets = await allCandidateTrackIds(browseServerId, trackId);
  await fanOutWithToast('star', targets, async (serverId, tid) => {
    await apiForServer(serverId, star ? 'star.view' : 'unstar.view', { id: tid });
    patchLibraryTrackOnUse(serverId, tid, { starredAt: star ? Date.now() : null });
  });
}

/** Fan-out rating to all cluster members holding the track. */
export async function clusterFanOutRating(
  browseServerId: string,
  trackId: string,
  rating: number,
): Promise<void> {
  if (!isClusterMode()) return;
  const targets = await allCandidateTrackIds(browseServerId, trackId);
  await fanOutWithToast('rating', targets, async (serverId, tid) => {
    await apiForServer(serverId, 'setRating.view', { id: tid, rating });
    patchLibraryTrackOnUse(serverId, tid, { userRating: rating });
  });
}
