import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runLocalBrowseAlbums = vi.fn();
const runNetworkBrowseAlbums = vi.fn();
const raceBrowseWithLocalFallback = vi.fn();
const isClusterMultiLibraryScopeBrowse = vi.fn();

vi.mock('../utils/library/browseTextSearch', () => ({
  BROWSE_TEXT_DEBOUNCE_RACE_MS: 0,
  BROWSE_TEXT_DEBOUNCE_NETWORK_MS: 0,
  browseRaceCountsAlbums: vi.fn(),
  raceBrowseWithLocalFallback: (...args: unknown[]) => raceBrowseWithLocalFallback(...args),
  runLocalBrowseAlbums: (...args: unknown[]) => runLocalBrowseAlbums(...args),
  runNetworkBrowseAlbums: (...args: unknown[]) => runNetworkBrowseAlbums(...args),
}));

vi.mock('../utils/serverCluster/clusterLibraryScopes', () => ({
  isClusterMultiLibraryScopeBrowse: () => isClusterMultiLibraryScopeBrowse(),
}));

import { useBrowseAlbumTextSearch } from './useBrowseAlbumTextSearch';

beforeEach(() => {
  vi.clearAllMocks();
  isClusterMultiLibraryScopeBrowse.mockReturnValue(false);
  runLocalBrowseAlbums.mockResolvedValue([
    { id: 'al-1', name: 'Local', artist: 'A', artistId: 'a', songCount: 1, duration: 1 },
  ]);
  runNetworkBrowseAlbums.mockResolvedValue([
    { id: 'net-1', name: 'Net', artist: 'B', artistId: 'b', songCount: 1, duration: 1 },
  ]);
  raceBrowseWithLocalFallback.mockResolvedValue({
    source: 'network',
    result: [{ id: 'net-1', name: 'Net', artist: 'B', artistId: 'b', songCount: 1, duration: 1 }],
  });
});

describe('useBrowseAlbumTextSearch', () => {
  it('uses local cluster index only when multi-library scope is active', async () => {
    isClusterMultiLibraryScopeBrowse.mockReturnValue(true);

    const { result } = renderHook(() =>
      useBrowseAlbumTextSearch('beatles', true, 'srv-a'),
    );

    await waitFor(() => {
      expect(result.current.textSearchLoading).toBe(false);
      expect(runLocalBrowseAlbums).toHaveBeenCalled();
    });

    expect(runLocalBrowseAlbums).toHaveBeenCalledWith('srv-a', 'beatles', undefined, false, true);
    expect(raceBrowseWithLocalFallback).not.toHaveBeenCalled();
    expect(runNetworkBrowseAlbums).not.toHaveBeenCalled();
    expect(result.current.textSearchAlbums).toHaveLength(1);
    expect(result.current.textSearchAlbums![0].id).toBe('al-1');
  });

  it('races local and network when cluster multi-library scope is inactive', async () => {
    const { result } = renderHook(() =>
      useBrowseAlbumTextSearch('beatles', true, 'srv-a'),
    );

    await waitFor(() => {
      expect(result.current.textSearchLoading).toBe(false);
      expect(raceBrowseWithLocalFallback).toHaveBeenCalled();
    });

    expect(result.current.textSearchAlbums![0].id).toBe('net-1');
  });
});
