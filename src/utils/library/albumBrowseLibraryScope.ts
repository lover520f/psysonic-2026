import { albumIdsInLibraryScope } from '../../api/subsonicLibrary';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { libraryScopeIdsForServer } from '../musicLibraryFilter';
import { resolveClusterBrowseMembers } from '../serverCluster/clusterBrowse';

/**
 * Navidrome-scoped album ids from getAlbumList2 (per musicFolderId).
 * Used when the local index has no reliable `library_id` on tracks — SQL
 * `libraryScope` alone would not narrow album browse.
 */
export async function resolveScopedAlbumRestrictIds(
  serverId: string,
): Promise<string[] | undefined> {
  if (!libraryScopeIdsForServer(serverId)?.length) return undefined;
  try {
    const ids = await albumIdsInLibraryScope(serverId);
    if (!ids) return undefined;
    return [...ids];
  } catch {
    return undefined;
  }
}

/** Client-side scope filter (server getAlbumList2 ids). Idempotent after SQL restrict. */
export async function filterAlbumsToServerLibraryScope(
  serverId: string,
  albums: SubsonicAlbum[],
  precomputedRestrict?: string[],
): Promise<SubsonicAlbum[]> {
  if (!libraryScopeIdsForServer(serverId)?.length) return albums;
  const restrict = precomputedRestrict ?? await resolveScopedAlbumRestrictIds(serverId);
  if (!restrict) return albums;
  const allowed = new Set(restrict);
  return albums.filter(a => allowed.has(a.id));
}

export function intersectAlbumRestrictIds(
  primary: string[] | undefined,
  scopeRestrict: string[] | undefined,
): string[] | undefined {
  if (!scopeRestrict?.length) return primary;
  if (!primary?.length) return scopeRestrict;
  const allowed = new Set(scopeRestrict);
  return primary.filter(id => allowed.has(id));
}

/** Per-member scoped album ids for merged cluster browse. */
export async function filterClusterAlbumsToLibraryScope(
  albums: SubsonicAlbum[],
): Promise<SubsonicAlbum[]> {
  const members = await resolveClusterBrowseMembers();
  if (!members?.length) return albums;

  const scopedMembers = members.filter(sid => libraryScopeIdsForServer(sid)?.length);
  if (scopedMembers.length === 0) return albums;

  const restrictByServer = new Map<string, Set<string>>();
  await Promise.all(
    scopedMembers.map(async sid => {
      const ids = await resolveScopedAlbumRestrictIds(sid);
      if (ids?.length) restrictByServer.set(sid, new Set(ids));
    }),
  );
  if (restrictByServer.size === 0) return albums;

  return albums.filter(a => {
    const seedServerId = a.clusterSeedServerId;
    if (!seedServerId) return true;
    const allowed = restrictByServer.get(seedServerId);
    if (!allowed) return true;
    return allowed.has(a.id);
  });
}
