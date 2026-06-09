import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchThemeStats } from './themeStats';

const RAW = [
  { theme_id: 'latte', installs: 9, rating_avg: 4.5, rating_count: 2 },
  { theme_id: 'mocha', installs: 0, rating_avg: null, rating_count: 0 },
];

function mockFetch(data: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => data } as Response);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchThemeStats', () => {
  it('parses the service response into a keyed map', async () => {
    vi.stubGlobal('fetch', mockFetch(RAW));
    const m = await fetchThemeStats();
    expect(m.get('latte')).toEqual({ installs: 9, ratingAvg: 4.5, ratingCount: 2 });
    expect(m.get('mocha')).toEqual({ installs: 0, ratingAvg: null, ratingCount: 0 });
  });

  it('serves from cache within the TTL without a second fetch', async () => {
    const f = mockFetch(RAW);
    vi.stubGlobal('fetch', f);
    await fetchThemeStats();
    await fetchThemeStats();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('force bypasses the cache', async () => {
    const f = mockFetch(RAW);
    vi.stubGlobal('fetch', f);
    await fetchThemeStats();
    await fetchThemeStats({ force: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('falls back to the last-seen cache when the service is down', async () => {
    vi.stubGlobal('fetch', mockFetch(RAW));
    await fetchThemeStats();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const m = await fetchThemeStats({ force: true });
    expect(m.get('latte')?.installs).toBe(9);
  });

  it('returns an empty map when the service is down and nothing is cached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const m = await fetchThemeStats();
    expect(m.size).toBe(0);
  });
});
