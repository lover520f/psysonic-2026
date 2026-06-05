import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { dedupeById } from '../dedupeById';
import { albumToAlbum } from './advancedSearchLocal';
import { sharedServerFilters } from './albumBrowseFilters';
import {
  finalizeClusterAlbumBrowse,
  searchSingleServerAlbumBrowse,
} from './albumBrowseExecution';
import { albumSortClauses, sortSubsonicAlbums } from './albumBrowseSort';
import { libraryIsReady } from './libraryReady';
import type { AlbumBrowsePageResult, AlbumBrowseQuery } from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';
import {
  canUseClusterAlbumBrowse,
  clusterAlbumBrowseNeedsAdvanced,
  clusterBrowseAlbumsPage,
} from '../serverCluster/clusterBrowse';
import { clusterAdvancedSearchLocal } from './clusterAdvancedSearchLocal';
import { isClusterMode } from '../serverCluster/clusterScope';
import type { LibraryFilterClause } from '../../api/library';

function markServerStarredAlbums(albums: SubsonicAlbum[]) {
  return albums.map(a => ({ ...a, starred: a.starred ?? 'true' }));
}

function genreEqFilter(genre: string): LibraryFilterClause {
  return { field: 'genre', op: 'eq', value: genre };
}

async function runClusterAlbumBrowse(
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  restrictAlbumIds: string[] | undefined,
): Promise<AlbumBrowsePageResult | null> {
  const useServerStarredIds = restrictAlbumIds != null;
  const shared = sharedServerFilters(query, useServerStarredIds);
  const starredOnly = useServerStarredIds ? undefined : (query.starredOnly || undefined);
  const sort = albumSortClauses(query.sort);

  const finish = async (albums: SubsonicAlbum[], hasMore: boolean) => {
    let out = await finalizeClusterAlbumBrowse(albums);
    if (useServerStarredIds) out = markServerStarredAlbums(out);
    return { albums: out, hasMore };
  };

  if (query.genres.length > 1) {
    if (offset > 0) return { albums: [], hasMore: false };
    const pages = await Promise.all(
      query.genres.map(genre =>
        clusterAdvancedSearchLocal({
          query: undefined,
          entityTypes: ['album'],
          filters: [genreEqFilter(genre), ...shared],
          starredOnly,
          restrictAlbumIds: restrictAlbumIds ?? undefined,
          sort,
          limit: GENRE_ALBUM_FETCH_LIMIT,
          offset: 0,
          skipTotals: true,
        }),
      ),
    );
    if (pages.some(p => !p)) return { albums: [], hasMore: false };
    const merged = dedupeById(pages.flatMap(p => p!.albums.map(albumToAlbum)));
    return {
      albums: sortSubsonicAlbums(await finalizeClusterAlbumBrowse(merged), query.sort),
      hasMore: false,
    };
  }

  const genreFilters: LibraryFilterClause[] =
    query.genres.length === 1
      ? [genreEqFilter(query.genres[0])]
      : [];
  const resp = await clusterAdvancedSearchLocal({
    query: undefined,
    entityTypes: ['album'],
    filters: [...genreFilters, ...shared],
    starredOnly,
    restrictAlbumIds: restrictAlbumIds ?? undefined,
    sort,
    limit: pageSize,
    offset,
    skipTotals: true,
  });
  if (!resp) return { albums: [], hasMore: false };
  return finish(resp.albums.map(albumToAlbum), resp.albums.length === pageSize);
}

/** Local index: layered filters — see `albumBrowseExecution.ts`. */
export async function runLocalAlbumBrowse(
  serverId: string,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  restrictAlbumIds?: string[],
): Promise<AlbumBrowsePageResult | null> {
  if (canUseClusterAlbumBrowse(query, restrictAlbumIds)) {
    const clusterPage = await clusterBrowseAlbumsPage(offset, pageSize);
    if (clusterPage) return clusterPage;
  }
  if (isClusterMode() && clusterAlbumBrowseNeedsAdvanced(query)) {
    return runClusterAlbumBrowse(query, offset, pageSize, restrictAlbumIds);
  }
  if (isClusterMode()) return { albums: [], hasMore: false };
  if (!serverId || !(await libraryIsReady(serverId))) return null;

  return searchSingleServerAlbumBrowse(serverId, query, offset, pageSize, restrictAlbumIds);
}
