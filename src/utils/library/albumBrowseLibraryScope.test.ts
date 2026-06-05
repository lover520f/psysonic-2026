import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';

const albumIdsInLibraryScope = vi.fn();

vi.mock('../../api/subsonicLibrary', () => ({
  albumIdsInLibraryScope: (...args: unknown[]) => albumIdsInLibraryScope(...args),
}));

vi.mock('../serverCluster/clusterAlbumBrowseMembers', () => ({
  resolveClusterAlbumBrowseScopeContext: vi.fn(async () => ({
    members: ['srv-a', 'srv-b'],
    scopedMembers: ['srv-a'],
  })),
}));

vi.mock('../musicLibraryFilter', () => ({
  libraryScopeIdsForServer: vi.fn((sid: string) => (sid === 'srv-a' ? ['lib-1'] : undefined)),
}));

import {
  filterAlbumsToServerLibraryScope,
  filterClusterAlbumsToLibraryScope,
  filterClusterAlbumsWithScopeContext,
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
  it('drops albums outside network scope allowlist', async () => {
    albumIdsInLibraryScope.mockResolvedValue(new Set(['keep']));
    const out = await filterAlbumsToServerLibraryScope('srv-a', [
      { id: 'keep', name: 'a', artist: 'X', artistId: 'x', songCount: 1, duration: 1 },
      { id: 'drop', name: 'b', artist: 'Y', artistId: 'y', songCount: 1, duration: 1 },
    ]);
    expect(out.map(a => a.id)).toEqual(['keep']);
  });
});

describe('filterClusterAlbumsWithScopeContext', () => {
  const album = (id: string, clusterSeedServerId: string): SubsonicAlbum => ({
    id,
    name: id,
    artist: 'X',
    artistId: 'x',
    songCount: 1,
    duration: 1,
    clusterSeedServerId,
  });

  const scopeCtx = {
    members: ['srv-a', 'srv-b'],
    scopedMembers: ['srv-a'],
  };

  it('keeps only albums from scoped cluster members', () => {
    const out = filterClusterAlbumsWithScopeContext([
      album('a1', 'srv-a'),
      album('b1', 'srv-b'),
    ], scopeCtx);
    expect(out.map(a => a.id)).toEqual(['a1']);
  });

  it('async wrapper uses scope context', async () => {
    const out = await filterClusterAlbumsToLibraryScope([
      album('a1', 'srv-a'),
      album('b1', 'srv-b'),
    ]);
    expect(out.map(a => a.id)).toEqual(['a1']);
  });
});
