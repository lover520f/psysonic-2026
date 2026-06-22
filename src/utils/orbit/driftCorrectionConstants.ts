/**
 * Orbit smooth drift correction — tunable constants.
 *
 * A guest that has drifted slightly from the host's live position is nudged
 * back with a pitch-preserving speed change (≤ ±10%) instead of an audible
 * hard seek. These numbers govern the deadband, the ramp cadence, and the
 * time budgets the planner reasons about. See the approved spec
 * (workdocs: 2026-06-22-orbit-smooth-drift-correction-plan.md, v2) for the
 * rationale behind each value — they are deliberately chosen against the
 * 2.5 s Navidrome poll cadence and real extrapolation noise.
 */

/**
 * Drift at or below this is acceptable jitter (poll noise, extrapolation
 * error). Correcting smaller errors causes audible pumping and wastes IPC.
 * Also the amount subtracted from |drift| to get the "effective work" the
 * correction actually has to close.
 */
export const DRIFT_DEADBAND_MS = 500;

/**
 * Hysteresis exit: while actively correcting, treat the job as done once
 * |drift| falls to this — then ramp back to 1.0×. Below the deadband so we
 * don't flip-flop right at the 500 ms boundary.
 */
export const DRIFT_DONE_MS = 450;

/**
 * Hysteresis entry: only *start* a fresh correction (from 1.0×) once |drift|
 * reaches this. Above the deadband so brushing 500 ms doesn't kick off chatter.
 */
export const DRIFT_ENTER_MS = 550;

/**
 * Preferred completion horizon for short corrections when the track is long
 * enough. The planner picks the gentlest rate (closest to 1.0×) that still
 * closes the drift within this window — not the fastest rate. Capped by the
 * remaining track time near end-of-track (`T_target = min(this, T_track_rem)`).
 */
export const CORRECTION_TARGET_SEC = 30;

/** ±10% product cap on the correction rate. */
export const RATE_MIN = 0.9;
export const RATE_MAX = 1.1;

/** Quantised speed change per ramp step (1%). Predictable + testable. */
export const RATE_STEP = 0.01;

/**
 * The rate moves by one `RATE_STEP` every this many ms, both accelerating and
 * decelerating. A full 10% ramp therefore takes 5 s per leg — slow enough to
 * avoid clicks, fast enough to matter for sync.
 */
export const RAMP_TICK_MS = 500;

/**
 * Drift-correction loop cadence. Matches `RAMP_TICK_MS` (one step per tick) and
 * is faster than the 2.5 s state poll so we extrapolate host position between
 * polls.
 */
export const LOOP_TICK_MS = 500;
