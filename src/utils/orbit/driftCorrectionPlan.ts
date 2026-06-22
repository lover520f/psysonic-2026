/**
 * Orbit smooth drift correction — pure planner.
 *
 * Given the current drift and the host's position in the track, decide how to
 * close the gap: hold at 1.0×, nudge with a pitch-preserving speed change, or
 * (only when the gap can't be closed before the track ends) fall back to a
 * hard seek. No side effects — the runtime loop (`useOrbitGuestDriftCorrection`)
 * steps the live rate toward the planned target and re-plans every tick.
 *
 * The feasibility math is ramp-inclusive: a move from 1.00 → R takes
 * `RATE_STEP`-sized steps every `RAMP_TICK_MS`, so reaching ±10% costs ~10 s of
 * ramp time and closes ~550 ms of drift during the ramps alone. Ignoring that
 * (the naive `T = D / (0.10 * 1000)`) would under-budget every correction and
 * pick seeks where a soft nudge would have finished in time. See the approved
 * v2 spec for the derivation.
 */

import {
  CORRECTION_TARGET_SEC,
  DRIFT_DEADBAND_MS,
  DRIFT_DONE_MS,
  DRIFT_ENTER_MS,
  RAMP_TICK_MS,
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
} from './driftCorrectionConstants';

export interface DriftCorrectionInput {
  /**
   * Signed drift from `computeOrbitDriftMs`: `> 0` guest ahead (slow down),
   * `< 0` guest behind (speed up).
   */
  driftMs: number;
  trackDurationMs: number;
  hostPositionMs: number;
  hostIsPlaying: boolean;
  /** Current correction rate, for hysteresis. Defaults to 1.0 (not correcting). */
  currentRate?: number;
}

export type DriftCorrectionPlan =
  | { action: 'hold'; rate: 1.0 }
  | { action: 'soft'; targetRate: number; expectedDurationSec: number }
  | { action: 'seek' };

const HOLD: DriftCorrectionPlan = { action: 'hold', rate: 1.0 };
const SECONDS_PER_TICK = RAMP_TICK_MS / 1000;

/**
 * Real seconds to close `dEffMs` of drift using a peak correction rate of `rate`,
 * including both ramp legs (up to `rate` and back to 1.0×).
 *
 * Two regimes:
 *   - **Triangle** (`dEff ≤ D_ramp_total`): the ramps alone close the drift; the
 *     peak rate is never held. We find the smallest step count whose symmetric
 *     up/down ramp covers `dEff`. Time = `2 * steps * tick`.
 *   - **Trapezoid** (`dEff > D_ramp_total`): ramp up, hold a steady plateau at
 *     `rate`, ramp down. Time = ramp time + plateau time.
 *
 * Returns `Infinity` for a no-op rate (1.0×) so the scan skips it.
 */
export function driftCorrectionTimeSec(dEffMs: number, rate: number): number {
  if (dEffMs <= 0) return 0;
  const magnitude = Math.abs(rate - 1);
  const n = Math.round(magnitude / RATE_STEP);
  if (n <= 0) return Infinity;

  // Drift (ms) closed by one ramp leg of `k` steps: each step k' runs at
  // (1 + k'*STEP) for one tick, closing k'*STEP*1000*tick ms. Summed:
  //   Σ k'*STEP*1000*tick = STEP*1000*tick * n(n+1)/2.
  const legClosedMs = (steps: number) =>
    RATE_STEP * 1000 * SECONDS_PER_TICK * (steps * (steps + 1)) / 2;
  const rampTotalMs = 2 * legClosedMs(n);

  if (dEffMs <= rampTotalMs) {
    // Triangle: smallest m with a symmetric up/down ramp covering dEff.
    let m = 1;
    while (m < n && 2 * legClosedMs(m) < dEffMs) m += 1;
    return 2 * m * SECONDS_PER_TICK;
  }

  const rampSec = 2 * n * SECONDS_PER_TICK;
  const steadySec = (dEffMs - rampTotalMs) / (1000 * magnitude);
  return rampSec + steadySec;
}

/** Candidate peak rates from gentlest (±1%) to the ±10% cap, in the given direction. */
function candidateRates(direction: 1 | -1): number[] {
  const rates: number[] = [];
  for (let m = 1; m <= 10; m += 1) {
    const r = 1 + direction * m * RATE_STEP;
    // Guard the float cap — never propose a rate outside the product limit.
    if (r < RATE_MIN - 1e-9 || r > RATE_MAX + 1e-9) break;
    rates.push(Number(r.toFixed(2)));
  }
  return rates;
}

/**
 * Scan candidate rates (gentlest first) and return the minimum-magnitude rate
 * whose ramp-inclusive correction time fits `budgetSec`, or null if none does.
 */
function gentlestRateWithin(
  dEffMs: number,
  direction: 1 | -1,
  budgetSec: number,
): { rate: number; durationSec: number } | null {
  for (const rate of candidateRates(direction)) {
    const t = driftCorrectionTimeSec(dEffMs, rate);
    if (t <= budgetSec) return { rate, durationSec: t };
  }
  return null;
}

/**
 * Move `current` one `RATE_STEP` toward `target`, never overshooting and never
 * jumping more than a single step. The runtime loop calls this once per tick so
 * the rate ramps smoothly; snaps exactly to `target` (and to 1.0×) once within
 * a step to avoid float dust like 1.0000000002.
 */
export function stepRateToward(current: number, target: number, step: number = RATE_STEP): number {
  const delta = target - current;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

export function planOrbitDriftCorrection(input: DriftCorrectionInput): DriftCorrectionPlan {
  const { driftMs, trackDurationMs, hostPositionMs, hostIsPlaying } = input;
  const currentRate = input.currentRate ?? 1.0;

  // ── Guards → hold ──
  if (!hostIsPlaying) return HOLD;
  if (!(trackDurationMs > 0)) return HOLD;
  const tTrackRemSec = (trackDurationMs - hostPositionMs) / 1000;
  if (tTrackRemSec <= 0) return HOLD;

  // ── Hysteresis gate ──
  // Already correcting: keep going until we're comfortably back inside the
  // deadband (DONE), then ramp down. From rest: only start once drift clears
  // the higher ENTER threshold so brushing the boundary doesn't chatter.
  const correcting = Math.abs(currentRate - 1) > 1e-9;
  const absDrift = Math.abs(driftMs);
  if (correcting) {
    if (absDrift <= DRIFT_DONE_MS) return HOLD;
  } else if (absDrift < DRIFT_ENTER_MS) {
    return HOLD;
  }

  // Effective work above the deadband. ≤ 0 means we're inside the acceptable
  // jitter band — nothing to close.
  const dEff = Math.max(0, absDrift - DRIFT_DEADBAND_MS);
  if (dEff <= 0) return HOLD;

  // Guest behind (drift < 0) → speed up (R > 1); guest ahead → slow down.
  const direction: 1 | -1 = driftMs < 0 ? 1 : -1;
  const tTarget = Math.min(CORRECTION_TARGET_SEC, tTrackRemSec);

  // Phase A — gentlest rate that finishes within the preferred horizon.
  const phaseA = gentlestRateWithin(dEff, direction, tTarget);
  if (phaseA) {
    return { action: 'soft', targetRate: phaseA.rate, expectedDurationSec: phaseA.durationSec };
  }

  // Phase B — gentlest rate that still finishes before the track ends.
  // On a long track a large drift may legitimately need 40–60 s at the cap.
  const phaseB = gentlestRateWithin(dEff, direction, tTrackRemSec);
  if (phaseB) {
    return { action: 'soft', targetRate: phaseB.rate, expectedDurationSec: phaseB.durationSec };
  }

  // Phase C — even the ±10% cap can't close it before the track ends. Seek.
  return { action: 'seek' };
}
