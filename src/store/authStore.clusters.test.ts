/**
 * Server cluster model — create/order/remove, active scope, delete guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from './authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { clustersContainingServer, isClusterMode } from '@/utils/serverCluster/clusterScope';

vi.mock('@/utils/library/libraryReady', () => ({
  libraryIsReady: vi.fn(async () => true),
}));

vi.mock('@/utils/server/serverEndpoint', () => ({
  getCachedConnectBaseUrl: vi.fn(() => 'https://cached.test'),
}));

function addTwoServers(): { a: string; b: string } {
  const a = useAuthStore.getState().addServer({
    name: 'A',
    url: 'https://a.test',
    username: 'u',
    password: 'p',
  });
  const b = useAuthStore.getState().addServer({
    name: 'B',
    url: 'https://b.test',
    username: 'u',
    password: 'p',
  });
  return { a, b };
}

beforeEach(() => {
  resetAuthStore();
});

describe('createCluster', () => {
  it('requires at least two members', () => {
    const { a } = addTwoServers();
    expect(() => useAuthStore.getState().createCluster('X', [a])).toThrow(/two servers/i);
  });

  it('persists cluster with default clusterSyncPlayCounts true', () => {
    const { a, b } = addTwoServers();
    const id = useAuthStore.getState().createCluster(' Home ', [a, b]);
    const cluster = useAuthStore.getState().clusters.find(c => c.id === id);
    expect(cluster?.name).toBe('Home');
    expect(cluster?.serverIds).toEqual([a, b]);
    expect(cluster?.clusterSyncPlayCounts).toBe(true);
  });
});

describe('setActiveCluster / setActiveServer', () => {
  it('setActiveCluster enables cluster mode', () => {
    const { a, b } = addTwoServers();
    const id = useAuthStore.getState().createCluster('C', [a, b]);
    useAuthStore.getState().setActiveCluster(id);
    expect(isClusterMode()).toBe(true);
    expect(useAuthStore.getState().activeClusterId).toBe(id);
  });

  it('setActiveServer clears activeClusterId', () => {
    const { a, b } = addTwoServers();
    const id = useAuthStore.getState().createCluster('C', [a, b]);
    useAuthStore.getState().setActiveCluster(id);
    useAuthStore.getState().setActiveServer(a);
    expect(useAuthStore.getState().activeClusterId).toBeNull();
  });
});

describe('removeServerFromCluster', () => {
  it('deletes cluster when last member removed', () => {
    const { a, b } = addTwoServers();
    const id = useAuthStore.getState().createCluster('C', [a, b]);
    useAuthStore.getState().setActiveCluster(id);
    useAuthStore.getState().removeServerFromCluster(id, b);
    useAuthStore.getState().removeServerFromCluster(id, a);
    expect(useAuthStore.getState().clusters).toHaveLength(0);
    expect(useAuthStore.getState().activeClusterId).toBeNull();
  });
});

describe('removeServer guard', () => {
  it('throws when server is in any cluster', () => {
    const { a, b } = addTwoServers();
    useAuthStore.getState().createCluster('C', [a, b]);
    expect(() => useAuthStore.getState().removeServer(a)).toThrow('SERVER_IN_CLUSTER');
    expect(clustersContainingServer(a)).toHaveLength(1);
  });
});
