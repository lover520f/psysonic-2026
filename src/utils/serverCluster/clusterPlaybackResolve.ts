import { libraryClusterResolveCandidates, type LibraryClusterCandidateDto } from '../../api/library';
import { isClusterMode } from './clusterScope';
import { resolveClusterBrowseMembers } from './clusterBrowse';
import { isServerLikelyReachable } from './representative';

const candidateCache = new Map<string, LibraryClusterCandidateDto[]>();

function cacheKey(browseServerId: string, trackId: string): string {
  return `${browseServerId}:${trackId}`;
}

function pickAvailableCandidate(
  candidates: LibraryClusterCandidateDto[],
  skipServerId?: string,
): LibraryClusterCandidateDto | null {
  const sorted = [...candidates].sort((a, b) => a.priorityRank - b.priorityRank);
  for (const c of sorted) {
    if (skipServerId && c.serverId === skipServerId) continue;
    if (!isServerLikelyReachable(c.serverId)) continue;
    return c;
  }
  return sorted.find(c => !skipServerId || c.serverId !== skipServerId) ?? null;
}

/** Resolve a browsed track to a concrete `(serverId, trackId)` for playback. */
export async function resolveClusterPlaybackForTrack(
  browseServerId: string,
  trackId: string,
): Promise<{ serverId: string; trackId: string } | null> {
  if (!isClusterMode()) return null;
  const members = await resolveClusterBrowseMembers();
  if (!members) return null;
  try {
    const resp = await libraryClusterResolveCandidates({
      serversOrdered: members,
      serverId: browseServerId,
      trackId,
    });
    candidateCache.set(cacheKey(browseServerId, trackId), resp.candidates);
    const winner = pickAvailableCandidate(resp.candidates);
    if (!winner) return null;
    return { serverId: winner.serverId, trackId: winner.trackId };
  } catch {
    return null;
  }
}

/** Next candidate after a stream failure (cascade fallback). */
export async function cascadeClusterPlayback(
  browseServerId: string,
  browseTrackId: string,
  failedServerId: string,
): Promise<{ serverId: string; trackId: string } | null> {
  let candidates = candidateCache.get(cacheKey(browseServerId, browseTrackId));
  if (!candidates) {
    await resolveClusterPlaybackForTrack(browseServerId, browseTrackId);
    candidates = candidateCache.get(cacheKey(browseServerId, browseTrackId));
  }
  if (!candidates?.length) return null;
  const next = pickAvailableCandidate(candidates, failedServerId);
  if (!next) return null;
  return { serverId: next.serverId, trackId: next.trackId };
}

export function clearClusterPlaybackCache(): void {
  candidateCache.clear();
}
