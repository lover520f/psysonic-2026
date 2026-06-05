import type { MusicLibraryFilter } from '../utils/musicLibraryFilter';
import { normalizeMusicLibraryFilter } from '../utils/musicLibraryFilter';
import { invalidateClusterAlbumBrowseScopeCache } from '../utils/serverCluster/clusterAlbumBrowseMembers';
import { invalidateClusterMergeMemberCache } from '../utils/serverCluster/representative';
import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

function bumpFilter(
  set: SetState,
  next: Record<string, MusicLibraryFilter>,
): void {
  invalidateClusterMergeMemberCache();
  invalidateClusterAlbumBrowseScopeCache();
  set(s => ({
    musicLibraryFilterByServer: next,
    musicLibraryFilterVersion: s.musicLibraryFilterVersion + 1,
  }));
}

function resolveTargetServerId(get: GetState, targetServerId?: string): string | null {
  const { activeClusterId, clusters, activeServerId } = get();
  if (targetServerId) return targetServerId;
  if (activeClusterId) return null;
  return activeServerId;
}

/**
 * Per-server music-folder selection. `setMusicFolders` is called
 * after login / server change with the fresh Subsonic folder list;
 * if persisted filters point at folders that no longer exist,
 * they fall back to `'all'`.
 */
export function createMusicLibraryActions(set: SetState, get: GetState): Pick<
  AuthState,
  'setMusicFolders' | 'setMusicLibraryFilter' | 'toggleMusicLibraryFolder'
> {
  return {
    setMusicFolders: (folders) => {
      const sid = get().activeServerId;
      set(s => {
        if (!sid) return { musicFolders: folders };
        const f = normalizeMusicLibraryFilter(s.musicLibraryFilterByServer[sid]);
        const folderIds = new Set(folders.map(x => x.id));
        const invalidFilter =
          f !== 'all' && f.some(id => !folderIds.has(id));
        return {
          musicFolders: folders,
          ...(invalidFilter
            ? { musicLibraryFilterByServer: { ...s.musicLibraryFilterByServer, [sid]: 'all' } }
            : {}),
        };
      });
    },

    /** Exclusive select: one folder, or all libraries. */
    setMusicLibraryFilter: (folderId, targetServerId) => {
      const { activeClusterId, clusters } = get();
      if (folderId === 'all' && activeClusterId && !targetServerId) {
        const cluster = clusters.find(c => c.id === activeClusterId);
        if (!cluster) return;
        set(s => {
          const next = { ...s.musicLibraryFilterByServer };
          for (const sid of cluster.serverIds) next[sid] = 'all';
          return {
            musicLibraryFilterByServer: next,
            musicLibraryFilterVersion: s.musicLibraryFilterVersion + 1,
          };
        });
        return;
      }
      const sid = resolveTargetServerId(get, targetServerId);
      if (!sid) return;
      const next = { ...get().musicLibraryFilterByServer };
      next[sid] = folderId === 'all' ? 'all' : [folderId];
      bumpFilter(set, next);
    },

    /** Toggle one folder in a multi-select set (checkbox). */
    toggleMusicLibraryFolder: (folderId, targetServerId) => {
      const sid = resolveTargetServerId(get, targetServerId);
      if (!sid) return;
      set(s => {
        const next = { ...s.musicLibraryFilterByServer };
        const current = normalizeMusicLibraryFilter(next[sid]);
        if (current === 'all') {
          next[sid] = [folderId];
        } else if (current.includes(folderId)) {
          const rest = current.filter(id => id !== folderId);
          next[sid] = rest.length > 0 ? rest : 'all';
        } else {
          next[sid] = [...current, folderId];
        }
        invalidateClusterMergeMemberCache();
        invalidateClusterAlbumBrowseScopeCache();
        return {
          musicLibraryFilterByServer: next,
          musicLibraryFilterVersion: s.musicLibraryFilterVersion + 1,
        };
      });
    },
  };
}
