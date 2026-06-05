import { beforeEach, describe, expect, it, vi } from 'vitest';

const isClusterMode = vi.fn();
const getActiveClusterMemberIds = vi.fn();
const musicLibraryFilterForServer = vi.fn();

vi.mock('./clusterScope', () => ({
  isClusterMode: () => isClusterMode(),
  getActiveClusterMemberIds: () => getActiveClusterMemberIds(),
}));

vi.mock('../musicLibraryFilter', () => ({
  isAllLibrariesFilter: (f: unknown) => f === 'all',
  isLibraryFolderSelected: vi.fn(),
  libraryScopeSubtitleFromFolders: vi.fn(),
  musicLibraryFilterForServer: (sid: string) => musicLibraryFilterForServer(sid),
  musicLibraryFilterStorageKey: vi.fn(),
  libraryScopeIdsForServer: vi.fn(),
}));

import { isClusterMultiLibraryScopeBrowse } from './clusterLibraryScopes';

beforeEach(() => {
  vi.clearAllMocks();
  isClusterMode.mockReturnValue(true);
  getActiveClusterMemberIds.mockReturnValue(['srv-a', 'srv-b']);
});

describe('isClusterMultiLibraryScopeBrowse', () => {
  it('is false outside cluster mode', () => {
    isClusterMode.mockReturnValue(false);
    musicLibraryFilterForServer.mockReturnValue(['lib-1', 'lib-2']);
    expect(isClusterMultiLibraryScopeBrowse()).toBe(false);
  });

  it('is false with a single scoped folder', () => {
    musicLibraryFilterForServer.mockImplementation((sid: string) =>
      sid === 'srv-a' ? ['lib-1'] : 'all',
    );
    expect(isClusterMultiLibraryScopeBrowse()).toBe(false);
  });

  it('is true when one member has two folders selected', () => {
    musicLibraryFilterForServer.mockImplementation((sid: string) =>
      sid === 'srv-a' ? ['lib-1', 'lib-2'] : 'all',
    );
    expect(isClusterMultiLibraryScopeBrowse()).toBe(true);
  });

  it('is true when two members each have one folder selected', () => {
    musicLibraryFilterForServer.mockImplementation((sid: string) =>
      sid === 'srv-a' ? ['lib-1'] : ['lib-2'],
    );
    expect(isClusterMultiLibraryScopeBrowse()).toBe(true);
  });
});
