/**
 * Album browse — filter layering (local index paths):
 *
 * 1. **Library scope** — SQL `libraryScopeIds` / cluster `library_scopes` on `library_id`
 * 2. **Album attributes** (AND) — year, lossless, compilation, starred*
 * 3. **Genre** (OR union) — one `genre = ?` query per selected genre, results merged
 * 4. **Starred allowlist** — favorites `restrictAlbumIds` (local index ids)
 *
 * Network REST scope (`getAlbumList2`) is used only in `albumBrowseNetwork.ts` fallback.
 */
import {
  libraryAdvancedSearch,
  libraryListAlbums,
  libraryListAlbumsByGenre,
  libraryListLosslessAlbums,
  type LibraryFilterClause,
} from '../../api/library';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { libraryScopeInvokeArgs } from '../musicLibraryFilter';
import { dedupeById } from '../dedupeById';
import { albumToAlbum } from './advancedSearchLocal';
import {
  albumBrowseIsPureLossless,
  albumBrowseIsPurePlain,
  sharedServerFilters,
} from './albumBrowseFilters';
import { albumSortClauses, sortSubsonicAlbums } from './albumBrowseSort';
import type { AlbumBrowsePageResult, AlbumBrowseQuery } from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';

export type AlbumBrowseInvokeContext = {
  scopeArgs: ReturnType<typeof libraryScopeInvokeArgs>;
  invokeScope: ReturnType<typeof libraryScopeInvokeArgs> & {
    restrictAlbumIds?: string[];
  };
  useServerStarredIds: boolean;
  starredOnly: boolean | undefined;
  attributeFilters: LibraryFilterClause[];
};

export function resolveAlbumBrowseInvokeContext(
  serverId: string,
  query: AlbumBrowseQuery,
  restrictAlbumIds?: string[],
): AlbumBrowseInvokeContext {
  const scopeArgs = libraryScopeInvokeArgs(serverId);
  const useServerStarredIds = restrictAlbumIds != null;
  const invokeScope = {
    ...scopeArgs,
    ...(restrictAlbumIds?.length ? { restrictAlbumIds } : {}),
  };

  return {
    scopeArgs,
    invokeScope,
    useServerStarredIds,
    starredOnly: useServerStarredIds ? undefined : (query.starredOnly || undefined),
    attributeFilters: sharedServerFilters(query, useServerStarredIds),
  };
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
  const ctx = resolveAlbumBrowseInvokeContext(serverId, query, restrictAlbumIds);
  const sort = albumSortClauses(query.sort);

  const finish = (
    albums: SubsonicAlbum[],
    hasMore: boolean,
  ): AlbumBrowsePageResult => {
    const out = ctx.useServerStarredIds ? markServerStarredAlbums(albums) : albums;
    return { albums: out, hasMore };
  };

  if (query.genres.length > 1) {
    if (offset > 0) return { albums: [], hasMore: false };
    try {
      const merged = await fetchMultiGenreAlbumUnion(serverId, query, ctx);
      return {
        albums: sortSubsonicAlbums(finish(merged, false).albums, query.sort),
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
    if (albumBrowseIsPurePlain(query)) {
      const resp = await libraryListAlbums({
        serverId,
        ...ctx.scopeArgs,
        restrictAlbumIds: ctx.invokeScope.restrictAlbumIds,
        sort,
        limit: pageSize,
        offset,
      });
      if (resp.source !== 'local') return null;
      return finish(resp.albums.map(albumToAlbum), resp.hasMore);
    }
    if (albumBrowseIsPureLossless(query)) {
      const resp = await libraryListLosslessAlbums({
        serverId,
        ...ctx.scopeArgs,
        restrictAlbumIds: ctx.invokeScope.restrictAlbumIds,
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
