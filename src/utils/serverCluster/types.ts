/** Persisted server cluster definition (spec §3.2). */
export interface ServerCluster {
  id: string;
  name: string;
  /** Ordered member server profile ids; index 0 = highest priority. */
  serverIds: string[];
  /** Fan-out play-count scrobble submission=true to all members (default ON). */
  clusterSyncPlayCounts: boolean;
}
