/**
 * Cluster-mode browse helpers — merged index reads when `activeClusterId` is set.
 */
import {
  libraryClusterListFavoriteAlbums,
  libraryClusterListFavoriteArtists,
  libraryClusterListAlbums,
  libraryClusterListArtists,
  libraryClusterListFavorites,
  libraryClusterListTracks,
  librarySearchCluster,
} from '../../api/library';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../../api/subsonicTypes';
import { dedupeById } from '../dedupeById';
import { albumToAlbum, artistToArtist, trackToSong } from '../library/advancedSearchLocal';
import { albumBrowseHasServerFilters } from '../library/albumBrowseFilters';
import type { AlbumBrowsePageResult, AlbumBrowseQuery } from '../library/albumBrowseTypes';
import { buildClusterLibraryScopes } from './clusterLibraryScopes';
import { getActiveClusterId, isClusterMode } from './clusterScope';
import { getClusterMergeMemberIds } from './representative';

export async function resolveClusterBrowseMembers(): Promise<string[] | null> {
  if (!isClusterMode()) return null;
  const clusterId = getActiveClusterId();
  if (!clusterId) return null;
  const ids = await getClusterMergeMemberIds(clusterId);
  return ids.length > 0 ? ids : null;
}

export function canUseClusterAlbumBrowse(
  query: AlbumBrowseQuery,
  restrictAlbumIds?: string[],
): boolean {
  if (!isClusterMode()) return false;
  if (restrictAlbumIds != null) return false;
  if (albumBrowseHasServerFilters(query)) return false;
  if (query.compFilter !== 'all') return false;
  return true;
}

export async function clusterBrowseTracksPage(
  offset: number,
  pageSize: number,
): Promise<SubsonicSong[] | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members) return null;
  try {
    const env = await libraryClusterListTracks({
      serversOrdered: members,
      limit: pageSize,
      offset,
      libraryScopes: buildClusterLibraryScopes(members),
    });
    return env.tracks.map(trackToSong);
  } catch {
    return null;
  }
}

export async function clusterBrowseAlbumsPage(
  offset: number,
  pageSize: number,
): Promise<AlbumBrowsePageResult | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members) return null;
  try {
    const resp = await libraryClusterListAlbums({
      serversOrdered: members,
      limit: pageSize,
      offset,
      libraryScopes: buildClusterLibraryScopes(members),
    });
    return {
      albums: resp.albums.map(albumToAlbum),
      hasMore: resp.hasMore,
    };
  } catch {
    return null;
  }
}

export async function clusterBrowseArtistsPage(
  offset: number,
  pageSize: number,
): Promise<{ artists: SubsonicArtist[]; hasMore: boolean } | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members) return null;
  try {
    const resp = await libraryClusterListArtists({
      serversOrdered: members,
      limit: pageSize,
      offset,
      libraryScopes: buildClusterLibraryScopes(members),
    });
    const artists = resp.artists.map(artistToArtist);
    return { artists, hasMore: resp.hasMore };
  } catch {
    return null;
  }
}

export async function clusterBrowseTextSearch(
  query: string,
  limit: number,
): Promise<SubsonicSong[] | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members) return null;
  const q = query.trim();
  if (!q) return null;
  try {
    const resp = await librarySearchCluster({
      query: q,
      limit,
      serversOrdered: members,
    });
    return resp.hits.map(trackToSong);
  } catch {
    return null;
  }
}

/** Paginated cluster text search (fetch-through then slice — no Rust offset yet). */
export async function clusterBrowseTextSearchPage(
  query: string,
  offset: number,
  pageSize: number,
): Promise<SubsonicSong[] | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members) return null;
  const q = query.trim();
  if (!q) return null;
  try {
    const resp = await librarySearchCluster({
      query: q,
      limit: pageSize,
      offset,
      serversOrdered: members,
    });
    return resp.hits.map(trackToSong);
  } catch {
    return null;
  }
}

/** Merged favorites from the local index (starred on any member). */
export async function clusterLoadFavorites(): Promise<{
  songs: SubsonicSong[];
  albums: SubsonicAlbum[];
  artists: SubsonicArtist[];
} | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members) return null;
  try {
    const [tracksEnv, albumsResp, artistsResp] = await Promise.all([
      libraryClusterListFavorites({ serversOrdered: members, limit: 2000, offset: 0 }),
      libraryClusterListFavoriteAlbums({ serversOrdered: members, limit: 1000, offset: 0 }),
      libraryClusterListFavoriteArtists({ serversOrdered: members, limit: 1000, offset: 0 }),
    ]);
    const songs = tracksEnv.tracks.map(trackToSong);
    const albums = dedupeById(albumsResp.albums.map(albumToAlbum).map(a => ({ ...a, starred: a.starred ?? 'true' })));
    const artists = dedupeById(artistsResp.artists.map(artistToArtist).map(a => ({ ...a, starred: a.starred ?? 'true' })));
    return { songs, albums, artists };
  } catch {
    return null;
  }
}
