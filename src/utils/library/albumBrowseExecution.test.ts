import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAdvancedSearch = vi.fn();
const mockListAlbums = vi.fn();
const mockListByGenre = vi.fn();
const mockListLossless = vi.fn();
const mockScopeArgs = vi.fn();

vi.mock('../../api/library', () => ({
  libraryAdvancedSearch: (...args: unknown[]) => mockAdvancedSearch(...args),
  libraryListAlbums: (...args: unknown[]) => mockListAlbums(...args),
  libraryListAlbumsByGenre: (...args: unknown[]) => mockListByGenre(...args),
  libraryListLosslessAlbums: (...args: unknown[]) => mockListLossless(...args),
}));

vi.mock('../musicLibraryFilter', () => ({
  libraryScopeInvokeArgs: (...args: unknown[]) => mockScopeArgs(...args),
}));

import { searchSingleServerAlbumBrowse } from './albumBrowseExecution';

const baseQuery = {
  sort: 'alphabeticalByName' as const,
  genres: [] as string[],
  losslessOnly: false,
  starredOnly: false,
  compFilter: 'all' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockScopeArgs.mockReturnValue({ libraryScopeIds: ['lib-1'], libraryScope: 'lib-1' });
});

describe('searchSingleServerAlbumBrowse', () => {
  it('plain browse uses libraryListAlbums fast path', async () => {
    mockListAlbums.mockResolvedValue({
      source: 'local',
      albums: [{ id: 'al-1', name: 'Album', serverId: 's1' }],
      hasMore: false,
    });

    const result = await searchSingleServerAlbumBrowse('srv-1', baseQuery, 0, 30);

    expect(mockListAlbums).toHaveBeenCalled();
    expect(mockAdvancedSearch).not.toHaveBeenCalled();
    expect(result?.albums.map(a => a.id)).toEqual(['al-1']);
  });

  it('pure lossless uses libraryListLosslessAlbums with SQL scope only', async () => {
    mockListLossless.mockResolvedValue({
      source: 'local',
      albums: [{ id: 'flac-1', name: 'Hi-Res', serverId: 's1' }],
      hasMore: false,
    });

    const result = await searchSingleServerAlbumBrowse(
      'srv-1',
      { ...baseQuery, losslessOnly: true },
      0,
      30,
    );

    expect(mockListLossless).toHaveBeenCalledWith({
      serverId: 'srv-1',
      libraryScopeIds: ['lib-1'],
      libraryScope: 'lib-1',
      sort: [{ field: 'name', dir: 'asc' }],
      limit: 30,
      offset: 0,
    });
    expect(mockAdvancedSearch).not.toHaveBeenCalled();
    expect(result?.albums.map(a => a.id)).toEqual(['flac-1']);
  });

  it('lossless combined with year still uses advanced search', async () => {
    mockAdvancedSearch.mockResolvedValue({
      source: 'local',
      albums: [{ id: 'a1', name: 'A', serverId: 's1' }],
    });

    await searchSingleServerAlbumBrowse(
      'srv-1',
      { ...baseQuery, losslessOnly: true, year: { from: 1990 } },
      0,
      30,
    );

    expect(mockListLossless).not.toHaveBeenCalled();
    expect(mockAdvancedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          { field: 'lossless', op: 'is_true' },
          expect.objectContaining({ field: 'year' }),
        ]),
      }),
    );
  });

  it('multi-genre union uses advanced search per genre', async () => {
    mockAdvancedSearch
      .mockResolvedValueOnce({
        source: 'local',
        albums: [{ id: 'r1', name: 'Rock', serverId: 's1', genre: 'Rock' }],
      })
      .mockResolvedValueOnce({
        source: 'local',
        albums: [{ id: 'j1', name: 'Jazz', serverId: 's1', genre: 'Jazz' }],
      });

    const result = await searchSingleServerAlbumBrowse(
      'srv-1',
      { ...baseQuery, genres: ['Rock', 'Jazz'] },
      0,
      30,
    );

    expect(mockAdvancedSearch).toHaveBeenCalledTimes(2);
    expect(result?.albums.map(a => a.id).sort()).toEqual(['j1', 'r1']);
  });
});
