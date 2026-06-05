import { albumIdsInLibraryScope } from '../../api/subsonicLibrary';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { libraryScopeIdsForServer } from '../musicLibraryFilter';
import type { ClusterAlbumBrowseScopeContext } from '../serverCluster/clusterAlbumBrowseMembers';

/**
 * Navidrome-scoped album ids from getAlbumList2 — **network fallback only**
 * (`albumBrowseNetwork`, starred network pagination). Local index browse uses
 * SQL `libraryScopeIds` on `library_id` in the synced catalog.
 */
export async function resolveScopedAlbumAllowlist(
  serverId: string,
): Promise<Set<string> | null> {
  if (!libraryScopeIdsForServer(serverId)?.length) return null;
  try {
    return await albumIdsInLibraryScope(serverId);
  } catch {
    return null;
  }
}

export async function resolveScopedAlbumRestrictIds(
  serverId: string,
): Promise<string[] | undefined> {
  const allowlist = await resolveScopedAlbumAllowlist(serverId);
  return allowlist ? [...allowlist] : undefined;
}

/** Network post-filter after Subsonic `getAlbumList2` / starred REST reads. */
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

/** Cluster: drop albums from members outside the narrowed scope set (SQL handles folder ids). */
export function filterClusterAlbumsWithScopeContext(
  albums: SubsonicAlbum[],
  ctx: ClusterAlbumBrowseScopeContext,
): SubsonicAlbum[] {
  const { scopedMembers } = ctx;
  if (scopedMembers.length === 0) return albums;
  return albums.filter(a => {
    const seedServerId = a.clusterSeedServerId;
    return seedServerId != null && scopedMembers.includes(seedServerId);
  });
}

/** @deprecated Local paths use SQL scope; kept for callers that still async-wrap. */
export async function filterClusterAlbumsToLibraryScope(
  albums: SubsonicAlbum[],
): Promise<SubsonicAlbum[]> {
  const { resolveClusterAlbumBrowseScopeContext } = await import(
    '../serverCluster/clusterAlbumBrowseMembers'
  );
  const ctx = await resolveClusterAlbumBrowseScopeContext();
  if (!ctx) return albums;
  return filterClusterAlbumsWithScopeContext(albums, ctx);
}
