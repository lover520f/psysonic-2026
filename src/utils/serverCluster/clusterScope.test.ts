import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { getClusterMemberProfiles } from './clusterScope';

beforeEach(() => {
  resetAuthStore();
});

describe('getClusterMemberProfiles', () => {
  it('returns members in priority order and skips deleted servers', () => {
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
    const id = useAuthStore.getState().createCluster('C', [b, a]);
    const cluster = useAuthStore.getState().clusters.find(c => c.id === id)!;
    const profiles = getClusterMemberProfiles(cluster);
    expect(profiles.map(p => p.id)).toEqual([b, a]);
  });
});
