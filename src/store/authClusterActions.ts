import type { AuthState } from './authStoreTypes';
import type { ServerCluster } from '../utils/serverCluster/types';
import { generateId } from './authStoreHelpers';
import { recomputeClusterRepresentative } from '../utils/serverCluster/representative';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

function touchCluster(set: SetState, get: GetState, clusterId: string | null) {
  if (clusterId) {
    recomputeClusterRepresentative(clusterId);
  } else if (get().activeClusterId) {
    recomputeClusterRepresentative(get().activeClusterId!);
  }
}

export function createClusterActions(
  set: SetState,
  get: GetState,
): Pick<
  AuthState,
  | 'createCluster'
  | 'renameCluster'
  | 'setClusterOrder'
  | 'addServerToCluster'
  | 'removeServerFromCluster'
  | 'setClusterSyncPlayCounts'
  | 'deleteCluster'
  | 'setActiveCluster'
> {
  return {
    createCluster: (name, serverIds) => {
      if (serverIds.length < 2) {
        throw new Error('Cluster requires at least two servers');
      }
      const id = generateId();
      const cluster: ServerCluster = {
        id,
        name: name.trim() || 'Cluster',
        serverIds: [...serverIds],
        clusterSyncPlayCounts: true,
      };
      set(s => ({ clusters: [...s.clusters, cluster] }));
      return id;
    },

    renameCluster: (id, name) => {
      set(s => ({
        clusters: s.clusters.map(c =>
          c.id === id ? { ...c, name: name.trim() || c.name } : c,
        ),
      }));
    },

    setClusterOrder: (id, serverIds) => {
      set(s => ({
        clusters: s.clusters.map(c => (c.id === id ? { ...c, serverIds: [...serverIds] } : c)),
      }));
      touchCluster(set, get, id);
    },

    addServerToCluster: (id, serverId) => {
      set(s => ({
        clusters: s.clusters.map(c => {
          if (c.id !== id || c.serverIds.includes(serverId)) return c;
          return { ...c, serverIds: [...c.serverIds, serverId] };
        }),
      }));
      touchCluster(set, get, id);
    },

    removeServerFromCluster: (id, serverId) => {
      set(s => {
        const clusters = s.clusters
          .map(c => {
            if (c.id !== id) return c;
            const next = c.serverIds.filter(sid => sid !== serverId);
            return { ...c, serverIds: next };
          })
          .filter(c => c.serverIds.length > 0);
        const activeClusterId =
          s.activeClusterId === id && !clusters.some(c => c.id === id)
            ? null
            : s.activeClusterId;
        return { clusters, activeClusterId };
      });
      touchCluster(set, get, id);
    },

    setClusterSyncPlayCounts: (id, enabled) => {
      set(s => ({
        clusters: s.clusters.map(c =>
          c.id === id ? { ...c, clusterSyncPlayCounts: enabled } : c,
        ),
      }));
    },

    deleteCluster: id => {
      set(s => ({
        clusters: s.clusters.filter(c => c.id !== id),
        activeClusterId: s.activeClusterId === id ? null : s.activeClusterId,
      }));
    },

    setActiveCluster: id => {
      set({ activeClusterId: id });
      if (id) {
        void recomputeClusterRepresentative(id);
      }
    },
  };
}
