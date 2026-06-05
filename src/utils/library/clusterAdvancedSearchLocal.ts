import {
  libraryClusterAdvancedSearch,
  type LibraryAdvancedSearchResponse,
  type LibraryClusterAdvancedSearchRequest,
} from '../../api/library';
import { resolveClusterAlbumBrowseScopeContext } from '../serverCluster/clusterAlbumBrowseMembers';
import { buildClusterLibraryScopes } from '../serverCluster/clusterLibraryScopes';
import { isClusterMode } from '../serverCluster/clusterScope';

export async function clusterAdvancedSearchLocal(
  request: Omit<LibraryClusterAdvancedSearchRequest, 'serversOrdered'>,
): Promise<LibraryAdvancedSearchResponse | null> {
  if (!isClusterMode()) return null;
  const scopeCtx = await resolveClusterAlbumBrowseScopeContext();
  if (!scopeCtx) return null;
  const { members } = scopeCtx;
  try {
    return await libraryClusterAdvancedSearch({
      ...request,
      serversOrdered: members,
      libraryScopes: buildClusterLibraryScopes(members),
    });
  } catch {
    return null;
  }
}
