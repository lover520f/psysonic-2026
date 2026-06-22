/**
 * Orbit drift correction — pure bang-bang planner (v3).
 *
 * Decides what to do from the **smoothed** drift and the time left in the track:
 * hold at 1.0×, correct at the ±10% cap, or hard-seek. No ramp, no rate search —
 * the test round showed per-step speed switches cause artifacts and the fine
 * controller chases a noisy signal. Bang-bang makes exactly one speed switch to
 * start a correction and one to end it.
 *
 * `driftMs` MUST be the median-smoothed value (see `driftSmoothing`); acting on
 * the raw per-tick drift is what produced the oscillation in the first place.
 */

import {
  CLOSURE_MS_PER_SEC,
  DRIFT_DEADBAND_MS,
  DRIFT_DONE_MS,
  DRIFT_SEEK_HARD_MS,
  RATE_MAX,
  RATE_MIN,
} from './driftCorrectionConstants';

export interface DriftCorrectionInput {
  /** Smoothed, signed drift: `> 0` guest ahead (slow down), `< 0` behind (speed up). */
  driftMs: number;
  /** Seconds of track left at the host (hard ceiling for a soft correction). */
  trackRemSec: number;
  hostIsPlaying: boolean;
  /** True while already at a non-1.0 correction rate — widens the exit hysteresis. */
  correcting: boolean;
}

export type DriftCorrectionPlan =
  | { action: 'hold' }
  | { action: 'correct'; rate: number }
  | { action: 'seek' };

const HOLD: DriftCorrectionPlan = { action: 'hold' };

export function planOrbitDriftCorrection(input: DriftCorrectionInput): DriftCorrectionPlan {
  const { driftMs, trackRemSec, hostIsPlaying, correcting } = input;

  if (!hostIsPlaying) return HOLD;
  if (!(trackRemSec > 0)) return HOLD;

  const absDrift = Math.abs(driftMs);

  // Hysteresis: once correcting, keep going until comfortably caught up (DONE);
  // from rest, only start once the drift clears the larger deadband. The gap
  // between the two stops the controller flip-flopping at the boundary.
  if (correcting) {
    if (absDrift <= DRIFT_DONE_MS) return HOLD;
  } else if (absDrift <= DRIFT_DEADBAND_MS) {
    return HOLD;
  }

  // Too far for a soft nudge, or not enough track left to close it at the cap →
  // hard-seek to the host instead.
  if (absDrift > DRIFT_SEEK_HARD_MS) return { action: 'seek' };
  if (absDrift / CLOSURE_MS_PER_SEC > trackRemSec) return { action: 'seek' };

  // Bang-bang: behind (drift < 0) → speed up to the cap; ahead → slow to the cap.
  return { action: 'correct', rate: driftMs < 0 ? RATE_MAX : RATE_MIN };
}
