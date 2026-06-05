import { albumIdsInLibraryScope, getAlbumList } from '../../api/subsonicLibrary';
import { useAuthStore } from '../../store/authStore';
import { getAlbumsByGenre } from '../../api/subsonicGenres';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { dedupeById } from '../dedupeById';
import {
  filterAlbumsByCompilation,
  filterAlbumsByYearBounds,
} from './albumBrowseFilters';
import { albumYearSubsonicParams } from './albumYearFilter';
import { sortSubsonicAlbums } from './albumBrowseSort';
import type { AlbumBrowsePageResult, AlbumBrowseQuery } from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';

async function fetchByGenres(genres: string[]) {
  const results = await Promise.all(genres.map(g => getAlbumsByGenre(g, GENRE_ALBUM_FETCH_LIMIT, 0)));
  return dedupeById(results.flat());
}

async function applyNetworkPostFilters(
  albums: SubsonicAlbum[],
  query: AlbumBrowseQuery,
  scopedAlbumIds: Set<string> | null,
) {
  let out = albums;
  if (scopedAlbumIds) out = out.filter(a => scopedAlbumIds.has(a.id));
  if (query.year) out = filterAlbumsByYearBounds(out, query.year);
  out = filterAlbumsByCompilation(out, query.compFilter);
  if (query.starredOnly) out = out.filter(a => !!a.starred);
  return sortSubsonicAlbums(out, query.sort);
}

async function networkScopedAlbumIds(): Promise<Set<string> | null> {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return null;
  return albumIdsInLibraryScope(activeServerId);
}

export async function fetchAlbumBrowseNetwork(
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
): Promise<AlbumBrowsePageResult> {
  const scopedAlbumIds = await networkScopedAlbumIds();
  if (query.genres.length > 0) {
    if (query.genres.length === 1) {
      const data = await applyNetworkPostFilters(
        await getAlbumsByGenre(query.genres[0], pageSize, offset),
        query,
        scopedAlbumIds,
      );
      return { albums: data, hasMore: data.length === pageSize };
    }
    if (offset > 0) return { albums: [], hasMore: false };
    const data = await applyNetworkPostFilters(await fetchByGenres(query.genres), query, scopedAlbumIds);
    return { albums: data, hasMore: false };
  }

  if (query.starredOnly) {
    const extra = query.year ? albumYearSubsonicParams(query.year) : {};
    const data = await applyNetworkPostFilters(
      await getAlbumList('starred', pageSize, offset, extra),
      query,
      scopedAlbumIds,
    );
    return { albums: data, hasMore: data.length === pageSize };
  }

  if (query.year) {
    const data = await applyNetworkPostFilters(
      await getAlbumList(
        'byYear',
        pageSize,
        offset,
        albumYearSubsonicParams(query.year),
      ),
      query,
      scopedAlbumIds,
    );
    return { albums: data, hasMore: data.length === pageSize };
  }

  const data = await applyNetworkPostFilters(
    await getAlbumList(query.sort, pageSize, offset, {}),
    query,
    scopedAlbumIds,
  );
  return { albums: data, hasMore: data.length === pageSize };
}
