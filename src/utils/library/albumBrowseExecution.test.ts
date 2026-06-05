import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';

const mockAdvancedSearch = vi.fn();
const mockListByGenre = vi.fn();
const mockFilterScope = vi.fn();
const mockResolveRestrict = vi.fn();
const mockScopeArgs = vi.fn();

vi.mock('../../api/library', () => ({
  libraryAdvancedSearch: (...args: unknown[]) => mockAdvancedSearch(...args),
  libraryListAlbumsByGenre: (...args: unknown[]) => mockListByGenre(...args),
}));

vi.mock('../musicLibraryFilter', () => ({
  libraryScopeInvokeArgs: (...args: unknown[]) => mockScopeArgs(...args),
}));

vi.mock('./albumBrowseLibraryScope', () => ({
  resolveScopedAlbumRestrictIds: (...args: unknown[]) => mockResolveRestrict(...args),
  intersectAlbumRestrictIds: (
    primary: string[] | undefined,
    scope: string[] | undefined,
  ) => {
    if (!scope?.length) return primary;
    if (!primary?.length) return scope;
    const allowed = new Set(scope);
    return primary.filter(id => allowed.has(id));
  },
  filterAlbumsToServerLibraryScope: (
    _serverId: string,
    albums: SubsonicAlbum[],
  ) => mockFilterScope(albums),
}));

import { searchSingleServerAlbumBrowse } from './albumBrowseExecution';

const album = (id: string, genre?: string): SubsonicAlbum => ({
  id,
  name: id,
  artist: 'X',
  artistId: 'x',
  songCount: 1,
  duration: 1,
  genre,
});

const baseQuery = {
  sort: 'alphabeticalByName' as const,
  genres: [] as string[],
  losslessOnly: false,
  starredOnly: false,
  compFilter: 'all' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockScopeArgs.mockReturnValue({ libraryScopeIds: ['lib-1'] });
  mockResolveRestrict.mockResolvedValue(['scoped-a', 'scoped-b']);
  mockFilterScope.mockImplementation(async (albums: SubsonicAlbum[]) =>
    albums.filter(a => a.id.startsWith('scoped')),
  );
});

describe('searchSingleServerAlbumBrowse', () => {
  it('multi-genre union always runs library scope finalize', async () => {
    mockAdvancedSearch
      .mockResolvedValueOnce({
        source: 'local',
        albums: [{ id: 'scoped-a', name: 'A', serverId: 's1', genre: 'Rock' }],
      })
      .mockResolvedValueOnce({
        source: 'local',
        albums: [
          { id: 'scoped-b', name: 'B', serverId: 's1', genre: 'Jazz' },
          { id: 'leak', name: 'L', serverId: 's1', genre: 'Jazz' },
        ],
      });

    const result = await searchSingleServerAlbumBrowse(
      'srv-1',
      { ...baseQuery, genres: ['Rock', 'Jazz'] },
      0,
      30,
    );

    expect(mockAdvancedSearch).toHaveBeenCalledTimes(2);
    expect(mockFilterScope).toHaveBeenCalled();
    expect(result?.albums.map(a => a.id).sort()).toEqual(['scoped-a', 'scoped-b']);
    expect(result?.hasMore).toBe(false);
  });

  it('single pure genre also finalizes scope', async () => {
    mockListByGenre.mockResolvedValue({
      source: 'local',
      albums: [
        { id: 'scoped-a', name: 'A', serverId: 's1' },
        { id: 'leak', name: 'L', serverId: 's1' },
      ],
      hasMore: false,
    });

    const result = await searchSingleServerAlbumBrowse(
      'srv-1',
      { ...baseQuery, genres: ['Rock'] },
      0,
      30,
    );

    expect(mockListByGenre).toHaveBeenCalled();
    expect(mockFilterScope).toHaveBeenCalled();
    expect(result?.albums.map(a => a.id)).toEqual(['scoped-a']);
  });

  it('rejects offset pagination for multi-genre OR union', async () => {
    const result = await searchSingleServerAlbumBrowse(
      'srv-1',
      { ...baseQuery, genres: ['Rock', 'Jazz'] },
      30,
      30,
    );
    expect(result).toEqual({ albums: [], hasMore: false });
    expect(mockAdvancedSearch).not.toHaveBeenCalled();
  });
});
