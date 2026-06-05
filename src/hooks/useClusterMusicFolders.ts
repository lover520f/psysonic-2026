import { useEffect, useMemo, useState } from 'react';
import { apiForServer, libraryFilterParamsForServer } from '../api/subsonicClient';
import { useAuthStore } from '../store/authStore';
import { getCachedMusicFolders, setCachedMusicFolders } from '../utils/musicFoldersCache';
import { getActiveClusterMemberIds, isClusterMode } from '../utils/serverCluster/clusterScope';
import { isServerLikelyReachable } from '../utils/serverCluster/representative';
import { serverListDisplayLabel } from '../utils/server/serverDisplayName';

export interface ClusterMusicFolderEntry {
  serverId: string;
  serverLabel: string;
  folderId: string;
  folderName: string;
}

function buildEntriesForMembers(memberIds: string[]): ClusterMusicFolderEntry[] {
  const all = useAuthStore.getState().servers;
  const flat: ClusterMusicFolderEntry[] = [];
  for (const serverId of memberIds) {
    const folders = getCachedMusicFolders(serverId);
    if (!folders?.length) continue;
    const server = all.find(s => s.id === serverId);
    const label = server ? serverListDisplayLabel(server, all) : serverId;
    for (const f of folders) {
      flat.push({
        serverId,
        serverLabel: label,
        folderId: f.id,
        folderName: f.name?.trim() || f.id,
      });
    }
  }
  return flat;
}

async function fetchMusicFoldersForServer(serverId: string): Promise<ClusterMusicFolderEntry[]> {
  const data = await apiForServer<{
    musicFolders?: { musicFolder?: Array<{ id: string; name: string }> };
  }>(
    serverId,
    'getMusicFolders.view',
    libraryFilterParamsForServer(serverId),
  );
  const folders = (data.musicFolders?.musicFolder ?? []).map(f => ({
    id: String(f.id),
    name: f.name?.trim() || String(f.id),
  }));
  setCachedMusicFolders(serverId, folders);
  const all = useAuthStore.getState().servers;
  const server = all.find(s => s.id === serverId);
  const label = server ? serverListDisplayLabel(server, all) : serverId;
  return folders.map(f => ({
    serverId,
    serverLabel: label,
    folderId: f.id,
    folderName: f.name,
  }));
}

/** Navidrome/Subsonic music folders for cluster members (sidebar Library picker). */
export function useClusterMusicFolders(): { entries: ClusterMusicFolderEntry[]; loading: boolean } {
  const clusterId = useAuthStore(s => s.activeClusterId);
  const memberIds = useMemo(
    () => (clusterId && isClusterMode() ? getActiveClusterMemberIds() : []),
    [clusterId],
  );
  const [entries, setEntries] = useState<ClusterMusicFolderEntry[]>(() => buildEntriesForMembers(memberIds));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clusterId || !isClusterMode() || memberIds.length === 0) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setEntries(buildEntriesForMembers(memberIds));
    let cancelled = false;
    setLoading(true);
    const targets = memberIds.filter(isServerLikelyReachable);
    const fetchIds = targets.length > 0 ? targets : memberIds;
    void (async () => {
      const settled = await Promise.allSettled(fetchIds.map(fetchMusicFoldersForServer));
      if (cancelled) return;
      const flat: ClusterMusicFolderEntry[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') flat.push(...r.value);
      }
      setEntries(flat);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [clusterId, memberIds.join('|')]);

  return { entries, loading };
}
