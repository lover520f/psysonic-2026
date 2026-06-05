import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveClusterBrowseMembers = vi.fn();
const filterReadyClusterMemberIds = vi.fn();

vi.mock('./clusterBrowse', () => ({
  resolveClusterBrowseMembers: (...args: unknown[]) => resolveClusterBrowseMembers(...args),
}));

vi.mock('./representative', () => ({
  filterReadyClusterMemberIds: (...args: unknown[]) => filterReadyClusterMemberIds(...args),
}));

vi.mock('./clusterScope', () => ({
  getActiveClusterMemberIds: vi.fn(() => ['srv-a', 'srv-b', 'srv-c']),
  isClusterMode: vi.fn(() => true),
}));

vi.mock('../musicLibraryFilter', () => ({
  libraryScopeIdsForServer: vi.fn((sid: string) => (sid === 'srv-a' ? ['lib-1'] : undefined)),
}));

import {
  invalidateClusterAlbumBrowseScopeCache,
  narrowedClusterMemberIds,
  resolveAlbumBrowseIndexServerId,
  resolveClusterAlbumBrowseMembers,
  resolveClusterAlbumBrowseScopeContext,
} from './clusterAlbumBrowseMembers';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateClusterAlbumBrowseScopeCache();
  resolveClusterBrowseMembers.mockResolvedValue(['srv-a', 'srv-b', 'srv-c']);
  filterReadyClusterMemberIds.mockImplementation(async (ids: string[]) => ids);
});

describe('narrowedClusterMemberIds', () => {
  it('returns only members with sidebar scope', () => {
    expect(narrowedClusterMemberIds(['srv-a', 'srv-b'])).toEqual(['srv-a']);
  });
});

describe('resolveClusterAlbumBrowseMembers', () => {
  it('probes only narrowed members when scope is active', async () => {
    const members = await resolveClusterAlbumBrowseMembers();
    expect(members).toEqual(['srv-a']);
    expect(filterReadyClusterMemberIds).toHaveBeenCalledWith(['srv-a']);
    expect(resolveClusterBrowseMembers).not.toHaveBeenCalled();
  });
});

describe('resolveAlbumBrowseIndexServerId', () => {
  it('returns scoped member in cluster mode', () => {
    expect(resolveAlbumBrowseIndexServerId('srv-rep')).toBe('srv-a');
  });
});

describe('resolveClusterAlbumBrowseScopeContext', () => {
  it('caches member lists for repeated calls', async () => {
    const first = await resolveClusterAlbumBrowseScopeContext();
    const second = await resolveClusterAlbumBrowseScopeContext();
    expect(first?.members).toEqual(['srv-a']);
    expect(second).toBe(first);
    expect(filterReadyClusterMemberIds).toHaveBeenCalledOnce();
  });
});
