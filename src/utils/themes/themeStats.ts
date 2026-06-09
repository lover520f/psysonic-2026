/**
 * Theme Store global stats client. Reads per-theme install counts and ratings
 * from the self-hosted theme-stats service. Cached in localStorage with a TTL
 * so the store opens instantly and survives the service being briefly down.
 *
 * Only contacted when the Theme Store opt-in is on (the caller gates this).
 * No personal data is sent on the read; writes (install/rating pings) live in
 * a later step.
 */

const STATS_BASE = 'https://themes.stellnet.de';
const STATS_URL = `${STATS_BASE}/stats`;
const CACHE_KEY = 'psysonic_theme_stats_cache';
// Backend already caches /stats for 5 min; an hourly client TTL keeps the store
// snappy without showing very stale counts.
const TTL_MS = 60 * 60 * 1000;

export interface ThemeStat {
  installs: number;
  ratingAvg: number | null;
  ratingCount: number;
}

interface RawStat {
  theme_id: string;
  installs: number;
  rating_avg: number | null;
  rating_count: number;
}

interface CacheEnvelope {
  ts: number;
  stats: Record<string, ThemeStat>;
}

function readCache(): CacheEnvelope | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as CacheEnvelope;
    if (!env || typeof env.ts !== 'number' || !env.stats) return null;
    return env;
  } catch {
    return null;
  }
}

function writeCache(stats: Record<string, ThemeStat>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), stats }));
  } catch {
    // Quota / serialization failure is non-fatal — re-fetch next time.
  }
}

function toMap(stats: Record<string, ThemeStat>): Map<string, ThemeStat> {
  return new Map(Object.entries(stats));
}

/**
 * Per-theme stats keyed by theme id. Returns the cached copy while fresh, the
 * live service otherwise, and falls back to the last-seen cache (or an empty
 * map) when the service is unreachable.
 */
export async function fetchThemeStats(opts?: { force?: boolean }): Promise<Map<string, ThemeStat>> {
  const cached = readCache();
  if (!opts?.force && cached && Date.now() - cached.ts < TTL_MS) {
    return toMap(cached.stats);
  }
  try {
    // On force (manual refresh, or right after the user installs/rates) bypass
    // the browser HTTP cache too, so the user's own action shows up immediately.
    const res = await fetch(STATS_URL, {
      headers: { accept: 'application/json' },
      cache: opts?.force ? 'no-store' : 'default',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as RawStat[];
    if (!Array.isArray(raw)) throw new Error('unexpected payload');
    const stats: Record<string, ThemeStat> = {};
    for (const r of raw) {
      if (!r || typeof r.theme_id !== 'string') continue;
      stats[r.theme_id] = {
        installs: Number(r.installs) || 0,
        ratingAvg: typeof r.rating_avg === 'number' ? r.rating_avg : null,
        ratingCount: Number(r.rating_count) || 0,
      };
    }
    writeCache(stats);
    return toMap(stats);
  } catch {
    return cached ? toMap(cached.stats) : new Map();
  }
}

/** Report an install (best-effort, anonymous). Dedupe is server-side per client. */
export async function postInstall(themeId: string, clientKey: string): Promise<void> {
  try {
    await fetch(`${STATS_BASE}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeId, clientKey }),
    });
  } catch {
    // Best-effort telemetry — never block or surface to the user.
  }
}

/** Submit a 1–5 rating (best-effort, anonymous). One rating per client per theme. */
export async function postRating(themeId: string, clientKey: string, rating: number): Promise<void> {
  try {
    await fetch(`${STATS_BASE}/rate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeId, clientKey, rating }),
    });
  } catch {
    // Best-effort — never block or surface to the user.
  }
}
