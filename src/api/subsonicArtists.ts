import { useAuthStore } from '../store/authStore';
import { api, apiForServer, libraryFilterParams, libraryFilterParamsForServer } from './subsonicClient';
import { filterSongsToServerLibrary } from './subsonicLibrary';
import { filterSongsToActiveLibrary, similarSongsRequestCount } from './subsonicLibrary';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicArtistInfo,
  SubsonicSong,
} from './subsonicTypes';
import { isClusterMode } from '../utils/serverCluster/clusterScope';
import { resolveClusterBrowseMembers } from '../utils/serverCluster/clusterBrowse';
import { libraryClusterResolveCandidates } from './library';
import { mergeClusterTracks, resolveClusterSeedIds } from '../utils/serverCluster/clusterDiscoveryMerge';

export async function getArtists(): Promise<SubsonicArtist[]> {
  const data = await api<{ artists: { index: any } }>('getArtists.view', {
    ...libraryFilterParams(),
  });
  const rawIdx = data.artists?.index;
  const indices = Array.isArray(rawIdx) ? rawIdx : (rawIdx ? [rawIdx] : []);
  const artists: SubsonicArtist[] = [];
  for (const idx of indices) {
    const rawArt = idx.artist;
    const arr = Array.isArray(rawArt) ? rawArt : (rawArt ? [rawArt] : []);
    artists.push(...arr);
  }
  return artists;
}

export async function getArtist(id: string): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await api<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>('getArtist.view', { id });
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}

export async function getArtistForServer(
  serverId: string,
  id: string,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await apiForServer<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>(serverId, 'getArtist.view', { id });
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}

export async function getArtistInfo(id: string, options?: { similarArtistCount?: number }): Promise<SubsonicArtistInfo> {
  const count = options?.similarArtistCount ?? 5;
  const data = await api<{ artistInfo2: SubsonicArtistInfo }>('getArtistInfo2.view', { id, count, ...libraryFilterParams() });
  return data.artistInfo2 ?? {};
}

export async function getArtistInfoForServer(
  serverId: string,
  id: string,
  options?: { similarArtistCount?: number },
): Promise<SubsonicArtistInfo> {
  const count = options?.similarArtistCount ?? 5;
  const data = await apiForServer<{ artistInfo2: SubsonicArtistInfo }>(
    serverId,
    'getArtistInfo2.view',
    { id, count, ...libraryFilterParamsForServer(serverId) },
  );
  return data.artistInfo2 ?? {};
}

export async function getTopSongs(artist: string): Promise<SubsonicSong[]> {
  if (isClusterMode()) {
    return getTopSongsCluster(artist);
  }
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return [];
  return getTopSongsForServer(activeServerId, artist);
}

export async function getTopSongsForServer(serverId: string, artist: string): Promise<SubsonicSong[]> {
  try {
    const { musicLibraryFilterByServer } = useAuthStore.getState();
    const scoped = musicLibraryFilterByServer[serverId] && musicLibraryFilterByServer[serverId] !== 'all';
    const topCount = scoped ? 20 : 5;
    const data = await apiForServer<{ topSongs: { song: SubsonicSong[] } }>(
      serverId,
      'getTopSongs.view',
      { artist, count: topCount, ...libraryFilterParamsForServer(serverId) },
    );
    const raw = data.topSongs?.song ?? [];
    const filtered = await filterSongsToServerLibrary(raw, serverId);
    return filtered.slice(0, 5);
  } catch {
    return [];
  }
}

async function getTopSongsCluster(artist: string): Promise<SubsonicSong[]> {
  const members = await resolveClusterBrowseMembers();
  if (!members?.length) return [];
  const settled = await Promise.allSettled(
    members.map(serverId =>
      apiForServer<{ topSongs: { song: SubsonicSong[] } }>(
        serverId,
        'getTopSongs.view',
        { artist, count: 20, ...libraryFilterParamsForServer(serverId) },
      ).then(data => ({ serverId, songs: data.topSongs?.song ?? [] })),
    ),
  );
  const merged = mergeClusterTracks(
    settled.flatMap((row, idx) =>
      row.status === 'fulfilled'
        ? row.value.songs.map(song => ({
          item: { ...song, clusterBrowseServerId: row.value.serverId },
          serverId: row.value.serverId,
          priorityRank: idx,
        }))
        : [],
    ),
  );
  return merged.slice(0, 5);
}

export async function getSimilarSongs2(id: string, count = 50): Promise<SubsonicSong[]> {
  if (isClusterMode()) {
    const members = await resolveClusterBrowseMembers();
    if (!members?.length) return [];
    const requestCount = similarSongsRequestCount(count);
    const settled = await Promise.allSettled(
      members.map(serverId =>
        apiForServer<{ similarSongs2: { song: SubsonicSong[] } }>(
          serverId,
          'getSimilarSongs2.view',
          { id, count: requestCount, ...libraryFilterParamsForServer(serverId) },
        ).then(data => ({ serverId, songs: data.similarSongs2?.song ?? [] })),
      ),
    );
    const merged = mergeClusterTracks(
      settled.flatMap((row, idx) =>
        row.status === 'fulfilled'
          ? row.value.songs.map(song => ({
            item: { ...song, clusterBrowseServerId: row.value.serverId },
            serverId: row.value.serverId,
            priorityRank: idx,
          }))
          : [],
      ),
    );
    return merged.filter(s => s.id !== id).slice(0, count);
  }
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await api<{ similarSongs2: { song: SubsonicSong[] } }>('getSimilarSongs2.view', { id, count: requestCount, ...libraryFilterParams() });
    const raw = data.similarSongs2?.song ?? [];
    const filtered = await filterSongsToActiveLibrary(raw);
    return filtered.slice(0, count);
  } catch {
    return [];
  }
}

/** Similar tracks for a song id (Subsonic `getSimilarSongs`) — Navidrome + AudioMuse Instant Mix. */
export async function getSimilarSongs(
  id: string,
  count = 50,
  browseServerId?: string,
): Promise<SubsonicSong[]> {
  if (isClusterMode()) {
    const members = await resolveClusterBrowseMembers();
    if (!members?.length) return [];
    const activeServerId = browseServerId ?? useAuthStore.getState().activeServerId ?? members[0] ?? '';
    const requestCount = similarSongsRequestCount(count);
    const seedCandidates = await libraryClusterResolveCandidates({
      serversOrdered: members,
      serverId: activeServerId,
      trackId: id,
    }).catch(() => null);
    const seeds = resolveClusterSeedIds(
      Object.fromEntries((seedCandidates?.candidates ?? []).map(c => [c.serverId, c.trackId])),
      members,
    );
    const resolvedSeeds = seeds.length > 0
      ? seeds
      : members.map(serverId => ({ serverId, seedId: id }));
    const settled = await Promise.allSettled(
      resolvedSeeds.map(({ serverId, seedId }) =>
        apiForServer<{ similarSongs: { song: SubsonicSong | SubsonicSong[] } }>(
          serverId,
          'getSimilarSongs.view',
          { id: seedId, count: requestCount, ...libraryFilterParamsForServer(serverId) },
        ).then(data => {
          const raw = data.similarSongs?.song;
          const songs = !raw ? [] : Array.isArray(raw) ? raw : [raw];
          return { serverId, songs };
        }),
      ),
    );
    const merged = mergeClusterTracks(
      settled.flatMap((row, idx) =>
        row.status === 'fulfilled'
          ? row.value.songs.map(song => ({
            item: { ...song, clusterBrowseServerId: row.value.serverId },
            serverId: row.value.serverId,
            priorityRank: idx,
          }))
          : [],
      ),
    );
    return merged.filter(s => s.id !== id).slice(0, count);
  }
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await api<{ similarSongs: { song: SubsonicSong | SubsonicSong[] } }>('getSimilarSongs.view', { id, count: requestCount, ...libraryFilterParams() });
    const raw = data.similarSongs?.song;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const filtered = await filterSongsToActiveLibrary(list);
    return filtered.slice(0, count);
  } catch {
    return [];
  }
}
