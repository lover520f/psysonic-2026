/**
 * Cluster-mode virtual aggregate detail pages (spec §4 — `/album/:id`, `/artist/:id`).
 */
import {
  libraryClusterAlbumDetail,
  libraryClusterArtistDetail,
  type LibraryAlbumDto,
  type LibraryTrackDto,
} from '../../api/library';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../../api/subsonicTypes';
import { albumToAlbum, artistToArtist, trackToSong } from '../library/advancedSearchLocal';
import { resolveClusterBrowseMembers } from './clusterBrowse';

export async function loadClusterAlbumDetail(args: {
  albumId: string;
  seedServerId: string;
}): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[]; relatedAlbums: SubsonicAlbum[] } | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members?.length) return null;
  try {
    const resp = await libraryClusterAlbumDetail({
      serversOrdered: members,
      serverId: args.seedServerId,
      entityId: args.albumId,
    });
    return {
      album: albumToAlbum(resp.album),
      songs: resp.tracks.map(trackToSong),
      relatedAlbums: resp.relatedAlbums.map(albumToAlbum),
    };
  } catch {
    return null;
  }
}

export async function loadClusterArtistDetail(args: {
  artistId: string;
  seedServerId: string;
}): Promise<{
  artist: SubsonicArtist;
  albums: SubsonicAlbum[];
  topSongs: SubsonicSong[];
} | null> {
  const members = await resolveClusterBrowseMembers();
  if (!members?.length) return null;
  try {
    const resp = await libraryClusterArtistDetail({
      serversOrdered: members,
      serverId: args.seedServerId,
      entityId: args.artistId,
    });
    return {
      artist: artistToArtist(resp.artist),
      albums: resp.albums.map(albumToAlbum),
      topSongs: resp.topTracks.map(trackToSong),
    };
  } catch {
    return null;
  }
}

/** Map merged library rows when callers need raw DTO access. */
export function mapClusterAlbumDto(a: LibraryAlbumDto): SubsonicAlbum {
  return albumToAlbum(a);
}

export function mapClusterTrackDto(t: LibraryTrackDto): SubsonicSong {
  return trackToSong(t);
}
