/**
 * Orbit smooth drift correction — tunable constants (v3: bang-bang + smoothing).
 *
 * A guest that has drifted from the host's live position is nudged back with a
 * pitch-preserving speed change. v3 replaces the v2 ramp (1%/500 ms steps): the
 * test round showed the per-step speed switches caused audio artifacts and the
 * raw drift signal is far too noisy for a fine controller (it swings ±1500 ms
 * tick-to-tick with no real change). So now:
 *
 *   - The raw drift is median-smoothed before the controller sees it.
 *   - Correction is bang-bang: jump straight to the ±10% cap, hold until caught
 *     up, then jump back to 1.0× — two speed switches per cycle, not twenty.
 *   - After any speed change / seek the loop settles (ignores measurements) for
 *     a few ticks so a correction can't perturb its own next measurement.
 *
 * The host position only lands in ~5 s quanta, so sub-second sync is impossible
 * anyway — the deadband is sized accordingly.
 */

/**
 * Drift at or below this is left alone. Sized against the coarse (~5 s) host
 * position updates — chasing sub-second error is futile and just causes pumping.
 */
export const DRIFT_DEADBAND_MS = 1500;

/**
 * Hysteresis exit: while correcting, drop back to 1.0× once the smoothed drift
 * falls to this. Well below the deadband so we don't immediately re-trigger.
 */
export const DRIFT_DONE_MS = 600;

/** ±10% product cap on the correction rate. Bang-bang always uses the cap. */
export const RATE_MIN = 0.9;
export const RATE_MAX = 1.1;

/** Drift (ms) closed per second of real time at the ±10% cap. */
export const CLOSURE_MS_PER_SEC = (RATE_MAX - 1) * 1000; // 100 ms/s

/**
 * Beyond this smoothed drift a soft nudge is pointless (would take >50 s at the
 * cap) — hard-seek to the host instead. Also the fallback when the remaining
 * track is too short to close the gap softly.
 */
export const DRIFT_SEEK_HARD_MS = 5000;

/** Drift-correction loop cadence. Faster than the 2.5 s state poll. */
export const LOOP_TICK_MS = 500;

/**
 * Ticks to ignore after a speed change or seek, so the engine settles and the
 * correction doesn't read back its own perturbation. 4 ticks ≈ 2 s.
 */
export const DRIFT_SETTLE_TICKS = 4;

/** Median window over raw drift samples, and the minimum before acting. */
export const DRIFT_SMOOTH_WINDOW = 5;
export const DRIFT_SMOOTH_MIN_SAMPLES = 3;
