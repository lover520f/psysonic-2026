import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../../api/subsonicTypes';

type Ranked<T> = {
  item: T;
  serverId: string;
  priorityRank: number;
  clusterKey?: string | null;
};

function mergeByPriority<T extends { id?: string | null }>(
  rows: Ranked<T>[],
  keyOf: (row: Ranked<T>) => string | null,
): T[] {
  const best = new Map<string, Ranked<T>>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const prev = best.get(key);
    if (!prev || row.priorityRank < prev.priorityRank) best.set(key, row);
  }
  return [...best.values()]
    .sort((a, b) => a.priorityRank - b.priorityRank)
    .map(r => r.item);
}

function safeLower(v: string | undefined | null): string {
  return (v ?? '').trim().toLowerCase();
}

export function mergeClusterTracks(rows: Ranked<SubsonicSong>[]): SubsonicSong[] {
  return mergeByPriority(rows, row => {
    const keyed = row.clusterKey?.trim();
    if (keyed) return `cluster:${keyed}`;
    if (row.item.id) return `id:${row.item.id}`;
    return null;
  });
}

export function mergeClusterAlbums(rows: Ranked<SubsonicAlbum>[]): SubsonicAlbum[] {
  return mergeByPriority(rows, row => {
    const keyed = row.clusterKey?.trim();
    if (keyed) return `album:${keyed}`;
    const a = row.item;
    if (a.id) return `id:${a.id}`;
    const title = safeLower(a.name);
    const artist = safeLower(a.artist);
    return title ? `sig:${artist}:${title}` : null;
  });
}

export function mergeClusterArtists(rows: Ranked<SubsonicArtist>[]): SubsonicArtist[] {
  return mergeByPriority(rows, row => {
    const keyed = row.clusterKey?.trim();
    if (keyed) return `artist:${keyed}`;
    if (row.item.id) return `id:${row.item.id}`;
    const name = safeLower(row.item.name);
    return name ? `sig:${name}` : null;
  });
}

export function resolveClusterSeedIds(
  seedByServer: Record<string, string | undefined>,
  members: string[],
): Array<{ serverId: string; seedId: string }> {
  return members
    .map(serverId => ({ serverId, seedId: seedByServer[serverId] ?? '' }))
    .filter(row => row.seedId.length > 0);
}
