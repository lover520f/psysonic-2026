import { libraryScopeIdsForServer } from '../../api/subsonicClient';
import {
  isAllLibrariesFilter,
  isLibraryFolderSelected,
  libraryScopeSubtitleFromFolders,
  musicLibraryFilterForServer,
  musicLibraryFilterStorageKey,
} from '../musicLibraryFilter';
import { resolveServerIdForIndexKey } from '../server/serverLookup';
import { getActiveClusterMemberIds, isClusterMode } from './clusterScope';

/** Per-member Navidrome music-folder scopes for cluster index reads (omit = all libraries). */
export function buildClusterLibraryScopes(
  memberIds: string[],
): Record<string, string[]> | undefined {
  // Per-member folder id lists for merged cluster SQL (omit member = all libraries).
  const scopes: Record<string, string[]> = {};
  for (const sid of memberIds) {
    const ids = libraryScopeIdsForServer(sid);
    if (ids?.length) scopes[sid] = ids;
  }
  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

/** True when at least one cluster member narrowed the sidebar library picker. */
export function isClusterLibraryScopeNarrowed(): boolean {
  if (!isClusterMode()) return false;
  return buildClusterLibraryScopes(getActiveClusterMemberIds()) != null;
}

export function isClusterAllLibrariesSelected(memberIds: string[]): boolean {
  return memberIds.every(sid => isAllLibrariesFilter(musicLibraryFilterForServer(sid)));
}

export function clusterLibraryScopeSubtitle(
  memberIds: string[],
  entries: Array<{ serverId: string; serverLabel: string; folderId: string; folderName: string }>,
  multiLabel: (count: number) => string,
): string | null {
  if (isClusterAllLibrariesSelected(memberIds)) return null;
  const filters = memberIds.map(sid => ({ sid, f: musicLibraryFilterForServer(sid) }));
  const narrowed = filters.filter(x => x.f !== 'all');
  if (narrowed.length === 0) return null;
  if (narrowed.length === 1 && narrowed[0]!.f !== 'all') {
    const sid = narrowed[0]!.sid;
    const f = narrowed[0]!.f;
    const names = f
      .map(id => {
        const entry = entries.find(
          e => (resolveServerIdForIndexKey(e.serverId) || e.serverId) === sid && e.folderId === id,
        );
        return entry ? `${entry.serverLabel} — ${entry.folderName}` : id;
      })
      .filter(Boolean);
    if (names.length === 1) return names[0]!;
    if (names.length === 2) return `${names[0]} · ${names[1]}`;
    return multiLabel(names.length);
  }
  const total = narrowed.reduce((n, x) => n + (x.f === 'all' ? 0 : x.f.length), 0);
  return multiLabel(total);
}

export function isClusterLibraryFolderSelected(
  serverId: string,
  folderId: string,
): boolean {
  return isLibraryFolderSelected(serverId, folderId);
}

export function clusterLibraryFilterStorageKey(memberIds: string[]): string {
  if (isClusterAllLibrariesSelected(memberIds)) return 'all';
  return memberIds.map(sid => `${sid}:${musicLibraryFilterStorageKey(sid)}`).sort().join('|');
}

export function clusterLibraryPickerEntryId(serverId: string, folderId: string): string {
  return `${serverId}::${folderId}`;
}

export function parseClusterLibraryPickerEntryId(
  entryId: string,
): { serverId: string; folderId: string } | null {
  const sep = entryId.indexOf('::');
  if (sep <= 0) return null;
  return { serverId: entryId.slice(0, sep), folderId: entryId.slice(sep + 2) };
}
