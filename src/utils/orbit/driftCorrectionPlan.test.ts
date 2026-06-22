import { describe, expect, it } from 'vitest';

import { planOrbitDriftCorrection, type DriftCorrectionInput } from './driftCorrectionPlan';
import { RATE_MAX, RATE_MIN } from './driftCorrectionConstants';

function input(over: Partial<DriftCorrectionInput> = {}): DriftCorrectionInput {
  return { driftMs: 0, trackRemSec: 120, hostIsPlaying: true, correcting: false, ...over };
}

describe('planOrbitDriftCorrection (bang-bang)', () => {
  it('holds when the host is paused', () => {
    expect(planOrbitDriftCorrection(input({ driftMs: -5000, hostIsPlaying: false }))).toEqual({ action: 'hold' });
  });

  it('holds when no track time remains', () => {
    expect(planOrbitDriftCorrection(input({ driftMs: -3000, trackRemSec: 0 }))).toEqual({ action: 'hold' });
  });

  it('holds inside the deadband (from rest)', () => {
    expect(planOrbitDriftCorrection(input({ driftMs: -1400 }))).toEqual({ action: 'hold' }); // < 1500
  });

  it('corrects at the cap when behind beyond the deadband (speed up)', () => {
    expect(planOrbitDriftCorrection(input({ driftMs: -2000 }))).toEqual({ action: 'correct', rate: RATE_MAX });
  });

  it('corrects at the cap when ahead (slow down)', () => {
    expect(planOrbitDriftCorrection(input({ driftMs: 2000 }))).toEqual({ action: 'correct', rate: RATE_MIN });
  });

  it('always uses the full cap — never an intermediate rate', () => {
    for (const drift of [-1600, -3000, -4900, 1600, 4900]) {
      const p = planOrbitDriftCorrection(input({ driftMs: drift }));
      if (p.action === 'correct') expect([RATE_MIN, RATE_MAX]).toContain(p.rate);
    }
  });

  it('seeks when drift exceeds the hard threshold', () => {
    expect(planOrbitDriftCorrection(input({ driftMs: -6000 }))).toEqual({ action: 'seek' }); // > 5000
  });

  it('seeks when the gap cannot close before the track ends', () => {
    // 4000 ms needs 40 s at the cap; only 20 s left → seek.
    expect(planOrbitDriftCorrection(input({ driftMs: -4000, trackRemSec: 20 }))).toEqual({ action: 'seek' });
  });

  it('corrects (not seek) when there is just enough track left', () => {
    // 4000 ms needs 40 s; 60 s left → correct.
    expect(planOrbitDriftCorrection(input({ driftMs: -4000, trackRemSec: 60 }))).toEqual({ action: 'correct', rate: RATE_MAX });
  });

  describe('hysteresis', () => {
    it('from rest, does not start between DONE and the deadband', () => {
      // 1000 ms: above DONE (600), below deadband (1500), not correcting → hold.
      expect(planOrbitDriftCorrection(input({ driftMs: -1000, correcting: false }))).toEqual({ action: 'hold' });
    });

    it('while correcting, keeps going until drift falls to DONE', () => {
      expect(planOrbitDriftCorrection(input({ driftMs: -1000, correcting: true }))).toEqual({ action: 'correct', rate: RATE_MAX });
    });

    it('while correcting, holds once caught up to DONE', () => {
      expect(planOrbitDriftCorrection(input({ driftMs: -500, correcting: true }))).toEqual({ action: 'hold' }); // <= 600
    });
  });
});
