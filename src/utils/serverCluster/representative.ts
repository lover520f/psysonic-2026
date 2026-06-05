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
    const { activeServerId, setActiveServer, activeClusterId } = useAuthStore.getState();
    if (activeServerId !== server.id) {
      if (activeClusterId) {
        useAuthStore.setState({ activeServerId: server.id });
      } else {
        setActiveServer(server.id);
      }
    }
    return;
  }
  const fallback = members[0];
  if (fallback) {
    const { activeServerId, setActiveServer, activeClusterId } = useAuthStore.getState();
    if (activeServerId !== fallback.id) {
      if (activeClusterId) {
        useAuthStore.setState({ activeServerId: fallback.id });
      } else {
        setActiveServer(fallback.id);
      }
    }
  }
}

const MERGE_MEMBER_CACHE_TTL_MS = 15_000;

let mergeMemberCache: {
  clusterId: string;
  memberKey: string;
  ids: string[];
  expiresAt: number;
} | null = null;

/** Available + index-ready members in priority order (async). */
export async function getClusterMergeMemberIds(clusterId: string): Promise<string[]> {
  const { useAuthStore } = await import('../../store/authStore');
  const cluster = useAuthStore.getState().clusters.find(c => c.id === clusterId);
  if (!cluster) return [];
  const memberKey = cluster.serverIds.join(',');
  const now = Date.now();
  if (
    mergeMemberCache
    && mergeMemberCache.clusterId === clusterId
    && mergeMemberCache.memberKey === memberKey
    && mergeMemberCache.expiresAt > now
  ) {
    return mergeMemberCache.ids;
  }

  const members = getClusterMemberProfiles(cluster);
  const ready = await Promise.all(
    members.map(async server => {
      if (!isServerLikelyReachable(server.id)) return null;
      if (!(await libraryIsReady(server.id))) return null;
      return server.id;
    }),
  );
  const ids = ready.filter((id): id is string => id != null);
  mergeMemberCache = {
    clusterId,
    memberKey,
    ids,
    expiresAt: now + MERGE_MEMBER_CACHE_TTL_MS,
  };
  return ids;
}

export function invalidateClusterMergeMemberCache(): void {
  mergeMemberCache = null;
}

/** Ready subset in cluster priority order (skips full-cluster probe). */
export async function filterReadyClusterMemberIds(memberIds: string[]): Promise<string[]> {
  const ready = await Promise.all(
    memberIds.map(async id => {
      if (!isServerLikelyReachable(id)) return null;
      if (!(await libraryIsReady(id))) return null;
      return id;
    }),
  );
  return ready.filter((id): id is string => id != null);
}
