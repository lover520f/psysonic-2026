import {
  libraryClusterAdvancedSearch,
  type LibraryAdvancedSearchResponse,
  type LibraryClusterAdvancedSearchRequest,
} from '../../api/library';
import { resolveClusterBrowseMembers } from '../serverCluster/clusterBrowse';
import { buildClusterLibraryScopes } from '../serverCluster/clusterLibraryScopes';
import { isClusterMode } from '../serverCluster/clusterScope';

export async function clusterAdvancedSearchLocal(
  request: Omit<LibraryClusterAdvancedSearchRequest, 'serversOrdered'>,
): Promise<LibraryAdvancedSearchResponse | null> {
  if (!isClusterMode()) return null;
  const members = await resolveClusterBrowseMembers();
  if (!members?.length) return null;
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
