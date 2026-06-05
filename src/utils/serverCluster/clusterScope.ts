import { useAuthStore } from '../../store/authStore';
import type { ServerCluster } from './types';
import type { ServerProfile } from '../../store/authStoreTypes';

/** Active cluster scope, or null when a single server is active. */
export function getActiveClusterId(): string | null {
  return useAuthStore.getState().activeClusterId;
}

export function isClusterMode(): boolean {
  return getActiveClusterId() != null;
}

export function getActiveCluster(): ServerCluster | null {
  const { activeClusterId, clusters } = useAuthStore.getState();
  if (!activeClusterId) return null;
  return clusters.find(c => c.id === activeClusterId) ?? null;
}

/** Ordered member profiles that still exist in `servers`. */
export function getClusterMemberProfiles(cluster: ServerCluster): ServerProfile[] {
  const { servers } = useAuthStore.getState();
  return cluster.serverIds
    .map(id => servers.find(s => s.id === id))
    .filter((s): s is ServerProfile => s != null);
}

/** Member server ids for an active cluster (empty when not in cluster mode). */
export function getActiveClusterMemberIds(): string[] {
  const cluster = getActiveCluster();
  return cluster?.serverIds ?? [];
}

/** Clusters referencing a server (for delete guard). */
export function clustersContainingServer(serverId: string): ServerCluster[] {
  return useAuthStore.getState().clusters.filter(c => c.serverIds.includes(serverId));
}
