import { describe, expect, it, vi } from 'vitest';

vi.mock('../serverCluster/clusterScope', () => ({
  isClusterMode: vi.fn(() => false),
}));
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import {
  albumBrowseHasGenreFilter,
  albumBrowseHasServerFilters,
  albumBrowseIsPurePlain,
  albumBrowseIsPureLossless,
  albumBrowseMultiGenreBrowse,
  albumBrowseStarredNeedsLocalIntersect,
  albumBrowseUseSliceCatalog,
  compilationFilterClauses,
  countGenresFromAlbums,
  filterAlbumsByNameTextQuery,
  filterAlbumsByStarred,
  filterAlbumsByYearBounds,
} from './albumBrowseFilters';
import type { AlbumBrowseQuery } from './albumBrowseTypes';

describe('albumBrowseLoad', () => {
  const base: AlbumBrowseQuery = {
    sort: 'alphabeticalByName',
    genres: [],
    losslessOnly: false,
    starredOnly: false,
    compFilter: 'all',
  };

  it('detects combined server filters', () => {
    expect(albumBrowseHasServerFilters(base)).toBe(false);
    expect(albumBrowseHasServerFilters({ ...base, genres: ['Rock'] })).toBe(true);
    expect(albumBrowseHasServerFilters({ ...base, year: { from: 1990 } })).toBe(true);
    expect(albumBrowseHasServerFilters({ ...base, losslessOnly: true })).toBe(true);
    expect(albumBrowseHasServerFilters({ ...base, starredOnly: true })).toBe(true);
    expect(
      albumBrowseHasServerFilters({
        ...base,
        genres: ['Jazz'],
        year: { to: 2000 },
        losslessOnly: true,
      }),
    ).toBe(true);
  });

  it('genre filter disables pagination path', () => {
    expect(albumBrowseHasGenreFilter({ ...base, genres: ['Rock'] })).toBe(true);
  });

  it('detects pure plain browse', () => {
    expect(albumBrowseIsPurePlain(base)).toBe(true);
    expect(albumBrowseIsPurePlain({ ...base, genres: ['Rock'] })).toBe(false);
    expect(albumBrowseIsPurePlain({ ...base, compFilter: 'only' })).toBe(false);
  });

  it('detects pure lossless browse', () => {
    expect(albumBrowseIsPureLossless({ ...base, losslessOnly: true })).toBe(true);
    expect(albumBrowseIsPureLossless({ ...base, losslessOnly: true, year: { from: 1990 } })).toBe(
      false,
    );
    expect(albumBrowseIsPureLossless({ ...base, losslessOnly: true, genres: ['Rock'] })).toBe(
      false,
    );
  });

  it('slice catalog only for plain browse', async () => {
    const { isClusterMode } = await import('../serverCluster/clusterScope');
    expect(albumBrowseUseSliceCatalog(base)).toBe(true);
    expect(albumBrowseUseSliceCatalog({ ...base, compFilter: 'only' })).toBe(true);
    expect(albumBrowseUseSliceCatalog({ ...base, genres: ['Rock'] })).toBe(false);
    expect(albumBrowseUseSliceCatalog({ ...base, year: { from: 1990 } })).toBe(false);
    expect(albumBrowseUseSliceCatalog({ ...base, losslessOnly: true })).toBe(false);
    expect(albumBrowseUseSliceCatalog({ ...base, starredOnly: true })).toBe(false);
    expect(albumBrowseUseSliceCatalog(base, true)).toBe(false);
    vi.mocked(isClusterMode).mockReturnValueOnce(true);
    expect(albumBrowseUseSliceCatalog(base)).toBe(false);
  });

  it('multi-genre disables offset pagination', () => {
    expect(albumBrowseMultiGenreBrowse({ ...base, genres: ['Rock'] })).toBe(false);
    expect(albumBrowseMultiGenreBrowse({ ...base, genres: ['Rock', 'Jazz'] })).toBe(true);
  });

  it('starred + lossless uses local intersect when index is on', () => {
    expect(albumBrowseStarredNeedsLocalIntersect({ ...base, starredOnly: true }, true, 's1')).toBe(
      false,
    );
    expect(
      albumBrowseStarredNeedsLocalIntersect(
        { ...base, starredOnly: true, losslessOnly: true },
        true,
        's1',
      ),
    ).toBe(true);
    expect(
      albumBrowseStarredNeedsLocalIntersect(
        { ...base, starredOnly: true, genres: ['Rock'] },
        true,
        's1',
      ),
    ).toBe(true);
    expect(
      albumBrowseStarredNeedsLocalIntersect(
        { ...base, starredOnly: true, losslessOnly: true },
        false,
        's1',
      ),
    ).toBe(false);
  });
});

describe('filterAlbumsByStarred', () => {
  const album: SubsonicAlbum = {
    id: 'a1',
    name: 'A',
    artist: 'X',
    artistId: 'x',
    songCount: 1,
    duration: 1,
  };

  it('requires starred flag or a positive override', () => {
    expect(filterAlbumsByStarred([album], {})).toHaveLength(0);
    expect(filterAlbumsByStarred([{ ...album, starred: '2020-01-01' }], {})).toHaveLength(1);
    expect(filterAlbumsByStarred([album], { a1: true })).toHaveLength(1);
    expect(filterAlbumsByStarred([{ ...album, starred: '2020-01-01' }], { a1: false })).toHaveLength(0);
  });
});

describe('compilationFilterClauses', () => {
  it('maps only/hide to local index filters', () => {
    expect(compilationFilterClauses('only')).toEqual([{ field: 'compilation', op: 'is_true' }]);
    expect(compilationFilterClauses('hide')).toEqual([{ field: 'compilation', op: 'eq', value: false }]);
    expect(compilationFilterClauses('all')).toEqual([]);
  });
});

describe('countGenresFromAlbums', () => {
  const album = (id: string, genre?: string): SubsonicAlbum => ({
    id,
    name: 'A',
    artist: 'X',
    artistId: 'a',
    songCount: 1,
    duration: 1,
    genre,
  });

  it('returns genres sorted by album count descending', () => {
    expect(countGenresFromAlbums([
      album('1', 'Rock'),
      album('2', 'Jazz'),
      album('3', 'Rock'),
      album('4'),
    ])).toEqual([
      { genre: 'Rock', count: 2 },
      { genre: 'Jazz', count: 1 },
    ]);
  });
});

describe('filterAlbumsByNameTextQuery', () => {
  const albums: SubsonicAlbum[] = [
    { id: '1', name: 'Abbey Road', artist: 'The Beatles', artistId: 'a', songCount: 1, duration: 1 },
    { id: '2', name: 'Beatles for Sale', artist: 'The Beatles', artistId: 'a', songCount: 1, duration: 1 },
    { id: '3', name: 'Random Title', artist: 'Abbey Road Band', artistId: 'b', songCount: 1, duration: 1 },
  ];

  it('matches album title only, not artist name', () => {
    expect(filterAlbumsByNameTextQuery(albums, 'abbey').map(a => a.id)).toEqual(['1']);
    expect(filterAlbumsByNameTextQuery(albums, 'beatles').map(a => a.id)).toEqual(['2']);
  });
});

describe('filterAlbumsByYearBounds', () => {
  const albums: SubsonicAlbum[] = [
    { id: '1', name: 'A', artist: 'X', artistId: 'a', songCount: 1, duration: 1, year: 1985 },
    { id: '2', name: 'B', artist: 'Y', artistId: 'b', songCount: 1, duration: 1, year: 1995 },
    { id: '3', name: 'C', artist: 'Z', artistId: 'c', songCount: 1, duration: 1, year: 2005 },
  ];

  it('filters with only from bound', () => {
    expect(filterAlbumsByYearBounds(albums, { from: 1990 }).map(a => a.id)).toEqual(['2', '3']);
  });

  it('filters with only to bound', () => {
    expect(filterAlbumsByYearBounds(albums, { to: 1995 }).map(a => a.id)).toEqual(['1', '2']);
  });
});
