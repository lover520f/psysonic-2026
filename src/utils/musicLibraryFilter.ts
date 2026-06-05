import { useAuthStore } from '../store/authStore';
import { resolveServerIdForIndexKey } from './server/serverLookup';

/** Per-server Navidrome/Subsonic music-folder selection. */
export type MusicLibraryFilter = 'all' | string[];

export function normalizeMusicLibraryFilter(
  raw: MusicLibraryFilter | string | undefined,
): MusicLibraryFilter {
  if (raw === undefined) return 'all';
  if (raw === 'all') return 'all';
  if (typeof raw === 'string') return raw.trim() ? [raw] : 'all';
  const ids = [...new Set(raw.map(id => String(id).trim()).filter(Boolean))];
  return ids.length > 0 ? ids : 'all';
}

export function isAllLibrariesFilter(filter: MusicLibraryFilter): boolean {
  return filter === 'all';
}

export function musicLibraryFilterForServer(serverId: string): MusicLibraryFilter {
  const resolved = resolveServerIdForIndexKey(serverId) || serverId;
  const filters = useAuthStore.getState().musicLibraryFilterByServer;
  const raw = filters[resolved] ?? filters[serverId];
  return normalizeMusicLibraryFilter(raw);
}

/** Folder ids when narrowed; `undefined` = all libraries on this server. */
export function libraryScopeIdsForServer(serverId: string): string[] | undefined {
  const f = musicLibraryFilterForServer(serverId);
  return f === 'all' ? undefined : f;
}

/** First scope id for legacy single-scope callers (REST with one musicFolderId). */
export function libraryScopeForServer(serverId: string): string | undefined {
  const ids = libraryScopeIdsForServer(serverId);
  return ids?.[0];
}

/** `libraryScope` + `libraryScopeIds` for local index / Tauri invoke callers. */
export function libraryScopeInvokeArgs(serverId: string): {
  libraryScope?: string;
  libraryScopeIds?: string[];
} {
  const scopeIds = libraryScopeIdsForServer(serverId);
  if (!scopeIds?.length) return {};
  return {
    libraryScopeIds: scopeIds,
    ...(scopeIds.length === 1 ? { libraryScope: scopeIds[0] } : {}),
  };
}

export function isLibraryFolderSelected(serverId: string, folderId: string): boolean {
  const f = musicLibraryFilterForServer(serverId);
  return f === 'all' ? false : f.includes(folderId);
}

/** Stable key for sidebar unread / storage (sorted folder ids). */
export function musicLibraryFilterStorageKey(serverId: string): string {
  const f = musicLibraryFilterForServer(serverId);
  if (f === 'all') return 'all';
  return [...f].sort().join('+');
}

export function libraryScopeSubtitleFromFolders(
  folders: Array<{ id: string; name: string }>,
  filter: MusicLibraryFilter,
  multiLabel: (count: number) => string,
): string | null {
  if (filter === 'all') return null;
  const names = filter
    .map(id => folders.find(f => f.id === id)?.name ?? id)
    .filter(Boolean);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} · ${names[1]}`;
  return multiLabel(names.length);
}
