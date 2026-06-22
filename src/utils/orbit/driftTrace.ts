/**
 * Orbit drift correction — dense time-series trace.
 *
 * The Orbit event log (`orbitDiag`) is a 200-entry ring of *readable
 * transitions* (`soft→hold`, `seek`, `kicked`…). Sampling the drift loop into
 * it every 500 ms would overflow it in ~100 s and bury those transitions. So
 * the dense per-tick samples live here instead, in their own larger ring, and
 * the diagnostics popover offers them as a separate CSV copy that drops
 * straight into a spreadsheet/plot — the direct answer to "is the correction
 * actually working": does `drift` trend to 0 while `rate` is nudged?
 *
 * Pure in-memory bookkeeping — never re-renders, never hits IPC.
 */

/** ~10 min at the 500 ms loop cadence. */
const MAX_SAMPLES = 1200;

export interface DriftSample {
  ts: number;
  /** Raw drift this tick (noisy). */
  driftMs: number;
  /** Median-smoothed drift the controller acts on, or null before the window fills. */
  smoothedMs: number | null;
  rate: number;
  action: string;
  trackRemSec: number;
  hostPosMs: number;
  guestPosMs: number;
}

const buffer: DriftSample[] = [];

export function pushDriftSample(sample: DriftSample): void {
  buffer.push(sample);
  if (buffer.length > MAX_SAMPLES) buffer.splice(0, buffer.length - MAX_SAMPLES);
}

export function clearDriftTrace(): void {
  buffer.length = 0;
}

/** Number of samples currently buffered (for the copy-button label). */
export function driftTraceCount(): number {
  return buffer.length;
}

/**
 * Render the trace as a CSV block, oldest first. Header + one row per sample;
 * `rate`/`target` to 2 dp, positions/drift rounded to whole ms. Empty string
 * when nothing has been sampled yet.
 */
export function formatDriftTraceCsv(): string {
  if (buffer.length === 0) return '';
  const header = 'iso_ts,raw_ms,smoothed_ms,rate,action,rem_s,host_ms,guest_ms';
  const rows = buffer.map(s =>
    [
      new Date(s.ts).toISOString(),
      Math.round(s.driftMs),
      s.smoothedMs === null ? '' : Math.round(s.smoothedMs),
      s.rate.toFixed(2),
      s.action,
      s.trackRemSec.toFixed(1),
      Math.round(s.hostPosMs),
      Math.round(s.guestPosMs),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}
