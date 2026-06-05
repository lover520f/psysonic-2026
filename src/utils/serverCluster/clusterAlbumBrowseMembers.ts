import { getActiveClusterMemberIds, isClusterMode } from './clusterScope';
import { libraryScopeIdsForServer } from '../musicLibraryFilter';
import { resolveClusterBrowseMembers } from './clusterBrowse';
import { filterReadyClusterMemberIds } from './representative';

/** Cluster members with a narrowed sidebar library selection. */
export function narrowedClusterMemberIds(memberIds: string[]): string[] {
  return memberIds.filter(sid => libraryScopeIdsForServer(sid)?.length);
}

/**
 * Server id for single-server index reads (genre counts, plain list_albums).
 * In cluster mode with narrowed scope, use the scoped member — not `activeServerId`.
 */
export function resolveAlbumBrowseIndexServerId(activeServerId: string): string {
  if (!isClusterMode()) return activeServerId;
  const narrowed = narrowedClusterMemberIds(getActiveClusterMemberIds());
  if (narrowed.length >= 1) return narrowed[0]!;
  return activeServerId;
}

/**
 * Ready cluster members to query for All Albums.
 * When any member is scoped, only scoped ready members are included (unscoped
 * members are excluded from the merged view).
 */
export async function resolveClusterAlbumBrowseMembers(): Promise<string[] | null> {
  const clusterMembers = getActiveClusterMemberIds();
  const narrowed = narrowedClusterMemberIds(clusterMembers);
  if (narrowed.length > 0) {
    const ready = await filterReadyClusterMemberIds(narrowed);
    return ready.length > 0 ? ready : null;
  }
  return resolveClusterBrowseMembers();
}

export type ClusterAlbumBrowseScopeContext = {
  members: string[];
  scopedMembers: string[];
};

let scopeContextCache: ClusterAlbumBrowseScopeContext | null = null;

/** Cached member lists for one browse request chain (local SQL scope only). */
export async function resolveClusterAlbumBrowseScopeContext(
  members?: string[],
): Promise<ClusterAlbumBrowseScopeContext | null> {
  if (!members && scopeContextCache) return scopeContextCache;

  const resolved = members ?? await resolveClusterAlbumBrowseMembers();
  if (!resolved?.length) return null;

  const scopedMembers = narrowedClusterMemberIds(getActiveClusterMemberIds())
    .filter(sid => resolved.includes(sid));

  const ctx: ClusterAlbumBrowseScopeContext = {
    members: resolved,
    scopedMembers,
  };
  scopeContextCache = ctx;
  return ctx;
}

export function invalidateClusterAlbumBrowseScopeCache(): void {
  scopeContextCache = null;
}

/** @internal tests */
export function peekClusterAlbumBrowseScopeCache(): typeof scopeContextCache {
  return scopeContextCache;
}
