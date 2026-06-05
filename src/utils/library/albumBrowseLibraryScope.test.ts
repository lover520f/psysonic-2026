import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';

const albumIdsInLibraryScope = vi.fn();

vi.mock('../../api/subsonicLibrary', () => ({
  albumIdsInLibraryScope: (...args: unknown[]) => albumIdsInLibraryScope(...args),
}));

vi.mock('../serverCluster/clusterBrowse', () => ({
  resolveClusterBrowseMembers: vi.fn(async () => ['srv-a', 'srv-b']),
}));

vi.mock('../musicLibraryFilter', () => ({
  libraryScopeIdsForServer: vi.fn((sid: string) => (sid === 'srv-a' ? ['lib-1'] : undefined)),
}));

import {
  filterAlbumsToServerLibraryScope,
  filterClusterAlbumsToLibraryScope,
  intersectAlbumRestrictIds,
} from './albumBrowseLibraryScope';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('intersectAlbumRestrictIds', () => {
  it('returns scope restrict when primary is undefined', () => {
    expect(intersectAlbumRestrictIds(undefined, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('intersects starred ids with scoped ids', () => {
    expect(intersectAlbumRestrictIds(['a', 'c'], ['a', 'b'])).toEqual(['a']);
  });
});

describe('filterAlbumsToServerLibraryScope', () => {
  it('drops albums outside scoped allowlist', async () => {
    albumIdsInLibraryScope.mockResolvedValue(new Set(['keep']));
    const out = await filterAlbumsToServerLibraryScope('srv-a', [
      { id: 'keep', name: 'a', artist: 'X', artistId: 'x', songCount: 1, duration: 1 },
      { id: 'drop', name: 'b', artist: 'Y', artistId: 'y', songCount: 1, duration: 1 },
    ]);
    expect(out.map(a => a.id)).toEqual(['keep']);
  });
});

describe('filterClusterAlbumsToLibraryScope', () => {
  const album = (id: string, clusterSeedServerId: string): SubsonicAlbum => ({
    id,
    name: id,
    artist: 'X',
    artistId: 'x',
    songCount: 1,
    duration: 1,
    clusterSeedServerId,
  });

  it('keeps only albums in scoped member allowlist', async () => {
    albumIdsInLibraryScope.mockResolvedValue(new Set(['in-scope']));
    const out = await filterClusterAlbumsToLibraryScope([
      album('in-scope', 'srv-a'),
      album('other', 'srv-a'),
      album('any', 'srv-b'),
    ]);
    expect(out.map(a => a.id)).toEqual(['in-scope', 'any']);
  });
});
