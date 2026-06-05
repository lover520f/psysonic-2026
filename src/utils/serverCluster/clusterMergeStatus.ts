import { libraryIsReady } from '../library/libraryReady';
import { serverListDisplayLabel } from '../server/serverDisplayName';
import { getClusterMemberProfiles } from './clusterScope';
import { isServerLikelyReachable } from './representative';
import type { ServerCluster } from './types';

export type ClusterMemberExcludeReason = 'unreachable' | 'indexing';

export interface ClusterMemberStatus {
  serverId: string;
  label: string;
  included: boolean;
  reason?: ClusterMemberExcludeReason;
}

export interface ClusterMergeDiagnostics {
  members: ClusterMemberStatus[];
  mergeCount: number;
  totalCount: number;
}

/** Per-member merge eligibility (spec §4 exclusion rules). */
export async function getClusterMergeDiagnostics(
  cluster: ServerCluster,
): Promise<ClusterMergeDiagnostics> {
  const profiles = getClusterMemberProfiles(cluster);
  const members: ClusterMemberStatus[] = [];
  let mergeCount = 0;
  for (const p of profiles) {
    const label = serverListDisplayLabel(p, profiles);
    if (!isServerLikelyReachable(p.id)) {
      members.push({ serverId: p.id, label, included: false, reason: 'unreachable' });
      continue;
    }
    if (!(await libraryIsReady(p.id))) {
      members.push({ serverId: p.id, label, included: false, reason: 'indexing' });
      continue;
    }
    members.push({ serverId: p.id, label, included: true });
    mergeCount += 1;
  }
  return { members, mergeCount, totalCount: profiles.length };
}

export function formatExcludedMemberLabels(
  members: ClusterMemberStatus[],
): string {
  return members
    .filter(m => !m.included)
    .map(m => {
      const suffix = m.reason === 'indexing' ? ' (indexing)' : ' (offline)';
      return `${m.label}${suffix}`;
    })
    .join(', ');
}
