/**
 * Album browse — filter layering (every path must follow this order):
 *
 * 1. **Library scope** (sidebar picker) — SQL `libraryScopeIds` and/or REST album allowlist
 * 2. **Album attributes** (AND) — year, lossless, compilation, starred*
 * 3. **Genre** (OR union) — one `genre = ?` query per selected genre, results merged
 * 4. **Starred allowlist** — `restrictAlbumIds` when intersecting server favorites
 * 5. **Finalize** — always re-apply library scope allowlist on album rows (REST fallback)
 *
 * *Starred uses step 4 when server favorite ids are supplied; otherwise step 2 SQL filter.
 */
import {
  libraryAdvancedSearch,
  libraryListAlbumsByGenre,
  type LibraryFilterClause,
} from '../../api/library';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { libraryScopeInvokeArgs } from '../musicLibraryFilter';
import {
  filterAlbumsToServerLibraryScope,
  filterClusterAlbumsToLibraryScope,
  intersectAlbumRestrictIds,
  resolveScopedAlbumRestrictIds,
} from './albumBrowseLibraryScope';
import { dedupeById } from '../dedupeById';
import { albumToAlbum } from './advancedSearchLocal';
import { sharedServerFilters } from './albumBrowseFilters';
import { albumSortClauses, sortSubsonicAlbums } from './albumBrowseSort';
import type { AlbumBrowsePageResult, AlbumBrowseQuery } from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';
export type AlbumBrowseInvokeContext = {
  scopeArgs: ReturnType<typeof libraryScopeInvokeArgs>;
  effectiveRestrict: string[] | undefined;
  /** Passed to `libraryAdvancedSearch` / `libraryListAlbumsByGenre`. */
  invokeScope:
    | { restrictAlbumIds: string[] }
    | ReturnType<typeof libraryScopeInvokeArgs>;
  useServerStarredIds: boolean;
  starredOnly: boolean | undefined;
  /** Step 2 — year, lossless, compilation, starred (when not using allowlist). */
  attributeFilters: LibraryFilterClause[];
};

export async function resolveAlbumBrowseInvokeContext(
  serverId: string,
  query: AlbumBrowseQuery,
  restrictAlbumIds?: string[],
): Promise<AlbumBrowseInvokeContext> {
  const scopeArgs = libraryScopeInvokeArgs(serverId);
  const scopedRestrict = await resolveScopedAlbumRestrictIds(serverId);
  const effectiveRestrict = intersectAlbumRestrictIds(restrictAlbumIds, scopedRestrict);
  const useServerStarredIds = restrictAlbumIds != null;
  const invokeScope = effectiveRestrict != null
    ? { restrictAlbumIds: effectiveRestrict }
    : scopeArgs;

  return {
    scopeArgs,
    effectiveRestrict,
    invokeScope,
    useServerStarredIds,
    starredOnly: useServerStarredIds ? undefined : (query.starredOnly || undefined),
    attributeFilters: sharedServerFilters(query, useServerStarredIds),
  };
}

/** Step 5 — enforce sidebar library scope on every album row. */
export async function finalizeSingleServerAlbumBrowse(
  serverId: string,
  albums: SubsonicAlbum[],
  effectiveRestrict?: string[],
): Promise<SubsonicAlbum[]> {
  return filterAlbumsToServerLibraryScope(serverId, albums, effectiveRestrict);
}

/** Step 5 (cluster) — per-member scoped allowlists. */
export async function finalizeClusterAlbumBrowse(
  albums: SubsonicAlbum[],
): Promise<SubsonicAlbum[]> {
  return filterClusterAlbumsToLibraryScope(albums);
}

function genreEqFilter(genre: string): LibraryFilterClause {
  return { field: 'genre', op: 'eq', value: genre };
}

function markServerStarredAlbums(albums: SubsonicAlbum[]): SubsonicAlbum[] {
  return albums.map(a => ({ ...a, starred: a.starred ?? 'true' }));
}

/** Step 3 — OR union via parallel per-genre advanced search (offset 0 only). */
async function fetchMultiGenreAlbumUnion(
  serverId: string,
  query: AlbumBrowseQuery,
  ctx: AlbumBrowseInvokeContext,
): Promise<SubsonicAlbum[]> {
  const pages = await Promise.all(
    query.genres.map(genre =>
      libraryAdvancedSearch({
        serverId,
        ...ctx.invokeScope,
        entityTypes: ['album'],
        filters: [genreEqFilter(genre), ...ctx.attributeFilters],
        starredOnly: ctx.starredOnly,
        sort: albumSortClauses(query.sort),
        limit: GENRE_ALBUM_FETCH_LIMIT,
        offset: 0,
        skipTotals: true,
      }),
    ),
  );
  if (pages.some(p => p.source !== 'local')) {
    throw new Error('local index unavailable');
  }
  return dedupeById(pages.flatMap(p => p.albums.map(albumToAlbum)));
}

/** Single-server local index browse — one entry point for all filter combinations. */
export async function searchSingleServerAlbumBrowse(
  serverId: string,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  restrictAlbumIds?: string[],
): Promise<AlbumBrowsePageResult | null> {
  const ctx = await resolveAlbumBrowseInvokeContext(serverId, query, restrictAlbumIds);
  const sort = albumSortClauses(query.sort);

  const finish = async (
    albums: SubsonicAlbum[],
    hasMore: boolean,
  ): Promise<AlbumBrowsePageResult> => {
    let out = await finalizeSingleServerAlbumBrowse(serverId, albums, ctx.effectiveRestrict);
    if (ctx.useServerStarredIds) out = markServerStarredAlbums(out);
    return { albums: out, hasMore };
  };

  if (query.genres.length > 1) {
    if (offset > 0) return { albums: [], hasMore: false };
    try {
      const merged = await fetchMultiGenreAlbumUnion(serverId, query, ctx);
      const finished = await finish(merged, false);
      return {
        albums: sortSubsonicAlbums(finished.albums, query.sort),
        hasMore: false,
      };
    } catch {
      return null;
    }
  }

  if (query.genres.length === 1) {
    const genre = query.genres[0];
    const pureGenreQuery = ctx.attributeFilters.length === 0 && !ctx.starredOnly;
    try {
      if (pureGenreQuery && !ctx.useServerStarredIds) {
        const resp = await libraryListAlbumsByGenre({
          serverId,
          genre,
          ...ctx.scopeArgs,
          sort,
          limit: pageSize,
          offset,
        });
        if (resp.source !== 'local') return null;
        return finish(resp.albums.map(albumToAlbum), resp.hasMore);
      }
      const resp = await libraryAdvancedSearch({
        serverId,
        ...ctx.invokeScope,
        entityTypes: ['album'],
        filters: [genreEqFilter(genre), ...ctx.attributeFilters],
        starredOnly: ctx.starredOnly,
        sort,
        limit: pageSize,
        offset,
        skipTotals: true,
      });
      if (resp.source !== 'local') return null;
      return finish(resp.albums.map(albumToAlbum), resp.albums.length === pageSize);
    } catch {
      return null;
    }
  }

  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      ...ctx.invokeScope,
      entityTypes: ['album'],
      filters: ctx.attributeFilters,
      starredOnly: ctx.starredOnly,
      sort,
      limit: pageSize,
      offset,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    return finish(resp.albums.map(albumToAlbum), resp.albums.length === pageSize);
  } catch {
    return null;
  }
}
