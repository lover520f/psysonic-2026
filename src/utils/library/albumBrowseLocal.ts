import { libraryAdvancedSearch, libraryListAlbumsByGenre } from '../../api/library';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { libraryScopeForServer } from '../../api/subsonicClient';
import { dedupeById } from '../dedupeById';
import { albumToAlbum } from './advancedSearchLocal';
import { albumBrowseHasServerFilters, sharedServerFilters } from './albumBrowseFilters';
import { albumSortClauses, sortSubsonicAlbums } from './albumBrowseSort';
import { libraryIsReady } from './libraryReady';
import type { AlbumBrowsePageResult, AlbumBrowseQuery } from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';
import { canUseClusterAlbumBrowse, clusterBrowseAlbumsPage } from '../serverCluster/clusterBrowse';
import { clusterAdvancedSearchLocal } from './clusterAdvancedSearchLocal';
import { isClusterMode } from '../serverCluster/clusterScope';

function markServerStarredAlbums(albums: SubsonicAlbum[]) {
  return albums.map(a => ({ ...a, starred: a.starred ?? 'true' }));
}

/** Local index: combined genre + year + lossless filters (AND), genres OR union. */
export async function runLocalAlbumBrowse(
  serverId: string,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  restrictAlbumIds?: string[],
): Promise<AlbumBrowsePageResult | null> {
  const clusterAndFiltered = isClusterMode() && albumBrowseHasServerFilters(query);
  if (canUseClusterAlbumBrowse(query, restrictAlbumIds)) {
    const clusterPage = await clusterBrowseAlbumsPage(offset, pageSize);
    if (clusterPage) return clusterPage;
  }
  if (clusterAndFiltered) {
    const shared = sharedServerFilters(query, restrictAlbumIds != null);
    const resp = await clusterAdvancedSearchLocal({
      query: undefined,
      entityTypes: ['album'],
      filters: shared,
      starredOnly: restrictAlbumIds != null ? undefined : (query.starredOnly || undefined),
      restrictAlbumIds: restrictAlbumIds ?? undefined,
      sort: albumSortClauses(query.sort),
      limit: pageSize,
      offset,
      skipTotals: true,
    });
    if (!resp) return { albums: [], hasMore: false };
    return {
      albums: resp.albums.map(albumToAlbum),
      hasMore: resp.albums.length === pageSize,
    };
  }
  if (isClusterMode()) return { albums: [], hasMore: false };
  if (!serverId || !(await libraryIsReady(serverId))) return null;

  const scope = libraryScopeForServer(serverId) ?? undefined;
  const useServerStarredIds = restrictAlbumIds != null;
  const shared = sharedServerFilters(query, useServerStarredIds);
  const starredOnly = useServerStarredIds ? undefined : (query.starredOnly || undefined);

  if (query.genres.length > 0) {
    if (query.genres.length === 1) {
      try {
        const resp = await libraryListAlbumsByGenre({
          serverId,
          genre: query.genres[0],
          libraryScope: scope,
          sort: albumSortClauses(query.sort),
          limit: pageSize,
          offset,
        });
        if (resp.source !== 'local') return null;
        let albums = resp.albums.map(albumToAlbum);
        if (useServerStarredIds) albums = markServerStarredAlbums(albums);
        return { albums, hasMore: resp.hasMore };
      } catch {
        return null;
      }
    }
    if (offset > 0) return { albums: [], hasMore: false };
    try {
      const pages = await Promise.all(
        query.genres.map(genre =>
          libraryAdvancedSearch({
            serverId,
            libraryScope: scope,
            entityTypes: ['album'],
            filters: [{ field: 'genre', op: 'eq', value: genre }, ...shared],
            starredOnly,
            restrictAlbumIds: useServerStarredIds ? restrictAlbumIds : undefined,
            sort: albumSortClauses(query.sort),
            limit: GENRE_ALBUM_FETCH_LIMIT,
            offset: 0,
            skipTotals: true,
          }),
        ),
      );
      if (pages.some(p => p.source !== 'local')) return null;
      let merged = dedupeById(pages.flatMap(p => p.albums.map(albumToAlbum)));
      if (useServerStarredIds) merged = markServerStarredAlbums(merged);
      return {
        albums: sortSubsonicAlbums(merged, query.sort),
        hasMore: false,
      };
    } catch {
      return null;
    }
  }

  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: scope,
      entityTypes: ['album'],
      filters: shared,
      starredOnly,
      restrictAlbumIds: useServerStarredIds ? restrictAlbumIds : undefined,
      sort: albumSortClauses(query.sort),
      limit: pageSize,
      offset,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    let albums = resp.albums.map(albumToAlbum);
    if (useServerStarredIds) albums = markServerStarredAlbums(albums);
    return { albums, hasMore: albums.length === pageSize };
  } catch {
    return null;
  }
}
