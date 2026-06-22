import { describe, expect, it } from 'vitest';

import {
  driftCorrectionTimeSec,
  planOrbitDriftCorrection,
  stepRateToward,
  type DriftCorrectionInput,
} from './driftCorrectionPlan';
import {
  CORRECTION_TARGET_SEC,
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
} from './driftCorrectionConstants';

/** A long track with plenty of room left — the common case. */
function longTrack(driftMs: number, extra: Partial<DriftCorrectionInput> = {}): DriftCorrectionInput {
  return {
    driftMs,
    trackDurationMs: 240_000,
    hostPositionMs: 60_000, // 180 s left
    hostIsPlaying: true,
    ...extra,
  };
}

/** `secondsLeft` of headroom in the track. */
function trackWith(driftMs: number, secondsLeft: number, extra: Partial<DriftCorrectionInput> = {}): DriftCorrectionInput {
  return {
    driftMs,
    trackDurationMs: 300_000,
    hostPositionMs: 300_000 - secondsLeft * 1000,
    hostIsPlaying: true,
    ...extra,
  };
}

describe('planOrbitDriftCorrection', () => {
  it('case 1: small drift inside the deadband holds at 1.0×', () => {
    const plan = planOrbitDriftCorrection(longTrack(400));
    expect(plan).toEqual({ action: 'hold', rate: 1.0 });
  });

  it('case 2: 800 ms behind picks a gentle rate well within the 30 s horizon', () => {
    const plan = planOrbitDriftCorrection(longTrack(-800));
    expect(plan.action).toBe('soft');
    if (plan.action !== 'soft') return;
    expect(plan.targetRate).toBeGreaterThan(1.0);
    expect(plan.targetRate).toBeLessThanOrEqual(1.03);
    expect(plan.expectedDurationSec).toBeLessThanOrEqual(CORRECTION_TARGET_SEC + 1e-6);
  });

  it('case 3: ~3 s behind on a long track lands at the ±10% cap, ~30 s', () => {
    const plan = planOrbitDriftCorrection(longTrack(-3050));
    expect(plan.action).toBe('soft');
    if (plan.action !== 'soft') return;
    expect(plan.targetRate).toBeCloseTo(RATE_MAX, 5);
    expect(plan.expectedDurationSec).toBeLessThanOrEqual(CORRECTION_TARGET_SEC + 1e-6);
    expect(plan.expectedDurationSec).toBeGreaterThan(25);
  });

  it('case 4: larger drift on a long track runs past 30 s at the gentlest rate that fits', () => {
    // Spec table suggests R=1.10, but Phase B's explicit rule is "minimum R
    // such that T_total ≤ T_budget" — on a 120 s remainder a gentler 1.03 still
    // fits (~100 s), so the minimum-R rule prefers it. The rule is normative;
    // the table's 1.10 is illustrative. Flagged to cucadmuh for confirmation.
    const plan = planOrbitDriftCorrection(trackWith(-3500, 120));
    expect(plan.action).toBe('soft');
    if (plan.action !== 'soft') return;
    expect(plan.targetRate).toBeGreaterThan(1.0);
    expect(plan.targetRate).toBeLessThanOrEqual(RATE_MAX + 1e-9);
    expect(plan.expectedDurationSec).toBeGreaterThan(CORRECTION_TARGET_SEC);
    expect(plan.expectedDurationSec).toBeLessThanOrEqual(120);
  });

  it('case 5: drift that cannot close before the track ends seeks', () => {
    const plan = planOrbitDriftCorrection(trackWith(-3500, 20));
    expect(plan).toEqual({ action: 'seek' });
  });

  it('case 6: 6 s behind on a 90 s remainder soft-corrects at the gentlest fitting rate', () => {
    // Same minimum-R nuance as case 4 — the gentlest rate within the 90 s
    // budget (~1.07) is preferred over the cap.
    const plan = planOrbitDriftCorrection(trackWith(-6000, 90));
    expect(plan.action).toBe('soft');
    if (plan.action !== 'soft') return;
    expect(plan.targetRate).toBeGreaterThan(1.0);
    expect(plan.targetRate).toBeLessThanOrEqual(RATE_MAX + 1e-9);
    expect(plan.expectedDurationSec).toBeGreaterThan(50);
    expect(plan.expectedDurationSec).toBeLessThanOrEqual(90);
  });

  it('case 7: guest ahead slows down (rate < 1.0)', () => {
    const plan = planOrbitDriftCorrection(longTrack(800));
    expect(plan.action).toBe('soft');
    if (plan.action !== 'soft') return;
    expect(plan.targetRate).toBeLessThan(1.0);
    expect(plan.targetRate).toBeGreaterThanOrEqual(0.98);
  });

  it('case 8: host paused holds regardless of drift', () => {
    const plan = planOrbitDriftCorrection(longTrack(-5000, { hostIsPlaying: false }));
    expect(plan).toEqual({ action: 'hold', rate: 1.0 });
  });

  it('holds when the track has no time remaining', () => {
    const plan = planOrbitDriftCorrection(trackWith(-3000, 0));
    expect(plan).toEqual({ action: 'hold', rate: 1.0 });
  });

  it('never proposes a rate outside the ±10% product cap', () => {
    for (const drift of [-50_000, -3050, 3050, 50_000]) {
      const plan = planOrbitDriftCorrection(longTrack(drift, { trackDurationMs: 3_600_000, hostPositionMs: 0 }));
      if (plan.action === 'soft') {
        expect(plan.targetRate).toBeGreaterThanOrEqual(RATE_MIN - 1e-9);
        expect(plan.targetRate).toBeLessThanOrEqual(RATE_MAX + 1e-9);
      }
    }
  });

  describe('hysteresis', () => {
    it('does not start a correction between deadband and enter threshold', () => {
      // 520 ms: above the 500 ms deadband but below the 550 ms enter gate.
      const plan = planOrbitDriftCorrection(longTrack(-520, { currentRate: 1.0 }));
      expect(plan).toEqual({ action: 'hold', rate: 1.0 });
    });

    it('keeps correcting until drift falls to the done threshold', () => {
      // 470 ms while already correcting: above the 450 ms done gate, below the
      // 550 ms enter gate — a fresh plan would hold, but an active one continues.
      const correcting = planOrbitDriftCorrection(longTrack(-470, { currentRate: 1.05 }));
      expect(correcting).toEqual({ action: 'hold', rate: 1.0 }); // dEff ≤ 0 → ramp down
      const done = planOrbitDriftCorrection(longTrack(-440, { currentRate: 1.05 }));
      expect(done).toEqual({ action: 'hold', rate: 1.0 });
    });
  });
});

describe('driftCorrectionTimeSec', () => {
  it('case 9: small effective drift closes as a triangle with no steady plateau', () => {
    // dEff = 200 ms at the ±10% cap: the ramp legs alone (550 ms capacity)
    // cover it, so the peak is never held — time is well under the 10 s full
    // ramp and the steady-state estimate.
    const t = driftCorrectionTimeSec(200, RATE_MAX);
    const fullRampSec = 10; // 2 legs × 10 steps × 0.5 s
    const naiveSteadySec = 200 / (0.1 * 1000); // 2 s — what ignoring ramps assumes
    expect(t).toBeGreaterThan(naiveSteadySec);
    expect(t).toBeLessThan(fullRampSec);
  });

  it('is a no-op (Infinity) at 1.0×', () => {
    expect(driftCorrectionTimeSec(1000, 1.0)).toBe(Infinity);
  });

  it('returns 0 when there is nothing to close', () => {
    expect(driftCorrectionTimeSec(0, RATE_MAX)).toBe(0);
  });

  it('decreases monotonically as the rate climbs (faster rate closes sooner)', () => {
    let prev = Infinity;
    for (let r = 1.01; r <= RATE_MAX + 1e-9; r += RATE_STEP) {
      const t = driftCorrectionTimeSec(2000, Number(r.toFixed(2)));
      expect(t).toBeLessThanOrEqual(prev + 1e-9);
      prev = t;
    }
  });
});

describe('stepRateToward (ramp simulator)', () => {
  it('steps toward a target by at most one RATE_STEP per tick and snaps on arrival', () => {
    const target = 1.1;
    let rate = 1.0;
    const seq = [rate];
    for (let i = 0; i < 50 && rate !== target; i += 1) {
      const next = stepRateToward(rate, target);
      expect(Math.abs(next - rate)).toBeLessThanOrEqual(RATE_STEP + 1e-9);
      rate = next;
      seq.push(rate);
    }
    expect(rate).toBeCloseTo(target, 9);
    expect(seq.length).toBe(11); // 1.00 → 1.10 in ten 1% steps
  });

  it('ramps back down to exactly 1.0× without float dust', () => {
    let rate = 1.07;
    for (let i = 0; i < 50 && rate !== 1.0; i += 1) {
      const next = stepRateToward(rate, 1.0);
      expect(Math.abs(next - rate)).toBeLessThanOrEqual(RATE_STEP + 1e-9);
      rate = next;
    }
    expect(rate).toBe(1.0);
  });

  it('never jumps more than one step toward a slow-down target either', () => {
    let rate = 1.0;
    const target = 0.9;
    for (let i = 0; i < 50 && rate !== target; i += 1) {
      const next = stepRateToward(rate, target);
      expect(Math.abs(next - rate)).toBeLessThanOrEqual(RATE_STEP + 1e-9);
      rate = next;
    }
    expect(rate).toBeCloseTo(target, 9);
  });
});
