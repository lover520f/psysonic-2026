/** Session cache of Subsonic `getMusicFolders` per server (not persisted). */

export interface MusicFolderEntry {
  id: string;
  name: string;
}

const byServer = new Map<string, MusicFolderEntry[]>();

export function setCachedMusicFolders(serverId: string, folders: MusicFolderEntry[]): void {
  byServer.set(serverId, folders);
}

export function getCachedMusicFolders(serverId: string): MusicFolderEntry[] | undefined {
  return byServer.get(serverId);
}
