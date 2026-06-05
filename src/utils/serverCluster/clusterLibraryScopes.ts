import { libraryScopeForServer } from '../../api/subsonicClient';
import { useAuthStore } from '../../store/authStore';
import { resolveServerIdForIndexKey } from '../server/serverLookup';

/** Per-member Navidrome music-folder scopes for cluster index reads (omit = all libraries). */
export function buildClusterLibraryScopes(memberIds: string[]): Record<string, string> | undefined {
  const scopes: Record<string, string> = {};
  for (const sid of memberIds) {
    const scope = libraryScopeForServer(sid);
    if (scope) scopes[sid] = scope;
  }
  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

export function isClusterAllLibrariesSelected(memberIds: string[]): boolean {
  const filters = useAuthStore.getState().musicLibraryFilterByServer;
  return memberIds.every(sid => {
    const resolved = resolveServerIdForIndexKey(sid) || sid;
    const f = filters[resolved] ?? filters[sid];
    return f === undefined || f === 'all';
  });
}

/** Label for the sidebar scope subtitle when one member is narrowed. */
export function clusterLibraryScopeSubtitle(
  memberIds: string[],
  entries: Array<{ serverId: string; serverLabel: string; folderId: string; folderName: string }>,
): string | null {
  if (isClusterAllLibrariesSelected(memberIds)) return null;
  const filters = useAuthStore.getState().musicLibraryFilterByServer;
  for (const entry of entries) {
    const resolved = resolveServerIdForIndexKey(entry.serverId) || entry.serverId;
    const f = filters[resolved] ?? filters[entry.serverId];
    if (f && f !== 'all' && f === entry.folderId) {
      return `${entry.serverLabel} — ${entry.folderName}`;
    }
  }
  return null;
}

export function isClusterLibraryFolderSelected(
  serverId: string,
  folderId: string,
): boolean {
  const filters = useAuthStore.getState().musicLibraryFilterByServer;
  const resolved = resolveServerIdForIndexKey(serverId) || serverId;
  const f = filters[resolved] ?? filters[serverId];
  return f === folderId;
}

export function clusterLibraryPickerEntryId(serverId: string, folderId: string): string {
  return `${serverId}::${folderId}`;
}

/** Sidebar picker `filterId` in cluster mode (`all` or `serverId::folderId`). */
export function clusterPickerFilterId(
  memberIds: string[],
  entries: Array<{ serverId: string; folderId: string }>,
): string {
  if (isClusterAllLibrariesSelected(memberIds)) return 'all';
  for (const entry of entries) {
    if (isClusterLibraryFolderSelected(entry.serverId, entry.folderId)) {
      return clusterLibraryPickerEntryId(entry.serverId, entry.folderId);
    }
  }
  return 'all';
}

export function parseClusterLibraryPickerEntryId(
  entryId: string,
): { serverId: string; folderId: string } | null {
  const sep = entryId.indexOf('::');
  if (sep <= 0) return null;
  return { serverId: entryId.slice(0, sep), folderId: entryId.slice(sep + 2) };
}
