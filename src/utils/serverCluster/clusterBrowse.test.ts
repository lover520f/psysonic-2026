import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListTracks = vi.fn();
const mockListAlbums = vi.fn();
const mockListArtists = vi.fn();
const mockSearchCluster = vi.fn();
const mockGetMembers = vi.fn();

vi.mock('../../api/library', () => ({
  libraryClusterListTracks: (...args: unknown[]) => mockListTracks(...args),
  libraryClusterListAlbums: (...args: unknown[]) => mockListAlbums(...args),
  libraryClusterListArtists: (...args: unknown[]) => mockListArtists(...args),
  librarySearchCluster: (...args: unknown[]) => mockSearchCluster(...args),
}));

vi.mock('./clusterScope', () => ({
  isClusterMode: vi.fn(() => true),
  getActiveClusterId: vi.fn(() => 'c1'),
}));

vi.mock('./representative', () => ({
  getClusterMergeMemberIds: (...args: unknown[]) => mockGetMembers(...args),
}));

vi.mock('./clusterLibraryScopes', () => ({
  buildClusterLibraryScopes: vi.fn(() => undefined),
  isClusterLibraryScopeNarrowed: vi.fn(() => false),
}));

vi.mock('../library/advancedSearchLocal', () => ({
  trackToSong: (t: { id: string }) => ({ id: t.id, title: t.id }),
  albumToAlbum: (a: { id: string }) => ({ id: a.id, name: a.id }),
  artistToArtist: (a: { id: string }) => ({ id: a.id, name: a.id }),
}));

import {
  canUseClusterAlbumBrowse,
  clusterAlbumBrowseNeedsAdvanced,
  clusterBrowseTracksPage,
} from './clusterBrowse';
import { isClusterLibraryScopeNarrowed } from './clusterLibraryScopes';

describe('clusterBrowse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMembers.mockResolvedValue(['s1', 's2']);
  });

  it('clusterBrowseTracksPage calls merged list API', async () => {
    mockListTracks.mockResolvedValue({
      tracks: [{ id: 't1', serverId: 's1', title: 't1' }],
      total: 1,
    });
    const songs = await clusterBrowseTracksPage(0, 50);
    expect(songs).toEqual([{ id: 't1', title: 't1' }]);
    expect(mockListTracks).toHaveBeenCalledWith({
      serversOrdered: ['s1', 's2'],
      limit: 50,
      offset: 0,
    });
  });

  it('canUseClusterAlbumBrowse rejects filtered queries', () => {
    expect(
      canUseClusterAlbumBrowse(
        {
          genres: ['Rock'],
          losslessOnly: false,
          starredOnly: false,
          compFilter: 'all',
          sort: 'alphabeticalByName',
        },
        undefined,
      ),
    ).toBe(false);
  });

  it('clusterAlbumBrowseNeedsAdvanced covers comp-only and scoped plain browse', () => {
    const plain = {
      genres: [] as string[],
      losslessOnly: false,
      starredOnly: false,
      compFilter: 'all' as const,
      sort: 'alphabeticalByName' as const,
    };
    expect(clusterAlbumBrowseNeedsAdvanced(plain)).toBe(false);
    expect(clusterAlbumBrowseNeedsAdvanced({ ...plain, compFilter: 'only' })).toBe(true);
    expect(clusterAlbumBrowseNeedsAdvanced({ ...plain, genres: ['Rock'] })).toBe(true);
    vi.mocked(isClusterLibraryScopeNarrowed).mockReturnValueOnce(true);
    expect(clusterAlbumBrowseNeedsAdvanced(plain)).toBe(true);
  });
});
