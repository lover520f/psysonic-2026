import { getCachedConnectBaseUrl } from '../server/serverEndpoint';
import { libraryIsReady } from '../library/libraryReady';
import { getClusterMemberProfiles } from './clusterScope';

/** Best-effort sync reachability (sticky connect cache populated by probes). */
export function isServerLikelyReachable(serverId: string): boolean {
  return getCachedConnectBaseUrl(serverId) != null;
}

/**
 * Pick priority-1 among available members; set `activeServerId` representative.
 */
export async function recomputeClusterRepresentative(clusterId: string): Promise<void> {
  const { useAuthStore } = await import('../../store/authStore');
  const cluster = useAuthStore.getState().clusters.find(c => c.id === clusterId);
  if (!cluster) return;

  const members = getClusterMemberProfiles(cluster);
  for (const server of members) {
    if (!isServerLikelyReachable(server.id)) continue;
    if (!(await libraryIsReady(server.id))) continue;
    const { activeServerId, setActiveServer } = useAuthStore.getState();
    if (activeServerId !== server.id) {
      setActiveServer(server.id);
    }
    return;
  }
  const fallback = members[0];
  if (fallback) {
    const { activeServerId, setActiveServer } = useAuthStore.getState();
    if (activeServerId !== fallback.id) {
      setActiveServer(fallback.id);
    }
  }
}

/** Available + index-ready members in priority order (async). */
export async function getClusterMergeMemberIds(clusterId: string): Promise<string[]> {
  const { useAuthStore } = await import('../../store/authStore');
  const cluster = useAuthStore.getState().clusters.find(c => c.id === clusterId);
  if (!cluster) return [];
  const out: string[] = [];
  for (const server of getClusterMemberProfiles(cluster)) {
    if (!isServerLikelyReachable(server.id)) continue;
    if (!(await libraryIsReady(server.id))) continue;
    out.push(server.id);
  }
  return out;
}
