import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { setTransitionMode } from './playbackTransition';
import { computeAutodjManualBlendPlan, shouldAutodjInterruptBlend } from './autodjManualBlend';

/** Fully-loud track (500 bins, plays as 100 s) — no lead/trail silence. */
function loudBins(): number[] {
  return Array<number>(500).fill(200);
}

beforeEach(() => {
  // Reset the user transition bounds to Auto so the default-span tests are
  // independent of bound-override tests (Vitest keeps store state across cases).
  useAuthStore.setState({ autodjMinTransitionSec: 0, autodjMaxTransitionSec: 0 });
});

describe('shouldAutodjInterruptBlend', () => {
  it('is true while playing even when manual flag would be false', () => {
    setTransitionMode('autodj');
    useAuthStore.setState({ autodjSmoothSkip: true, gaplessEnabled: false });
    expect(shouldAutodjInterruptBlend(true, false)).toBe(true);
  });

  it('is false when JS auto-advance armed the handoff', () => {
    setTransitionMode('autodj');
    useAuthStore.setState({ autodjSmoothSkip: true, gaplessEnabled: false });
    expect(shouldAutodjInterruptBlend(true, true)).toBe(false);
  });
});

describe('computeAutodjManualBlendPlan', () => {
  it('returns an edge-mix plan for a mid-track skip with loud A and B', () => {
    const plan = computeAutodjManualBlendPlan(loudBins(), 100, 50, loudBins(), 100);
    expect(plan).not.toBeNull();
    expect(plan!.transitionDur).toBeGreaterThan(0);
    expect(plan!.outgoingGainAtMixStart).toBe(1);
    expect(plan!.incomingGainAtMixEnd).toBe(1);
  });

  it('fully ducks A (outgoing_gain_end = 0) on a mid-track loud skip', () => {
    // Skip lands well before A's outro zone → not scenario A → A must fade to 0.
    const plan = computeAutodjManualBlendPlan(loudBins(), 100, 50, loudBins(), 100);
    expect(plan).not.toBeNull();
    expect(plan!.outgoingGainAtMixEnd).toBe(0);
  });

  it('honours the user max transition bound', () => {
    useAuthStore.setState({ autodjMaxTransitionSec: 1 });
    const plan = computeAutodjManualBlendPlan(loudBins(), 100, 50, loudBins(), 100);
    expect(plan).not.toBeNull();
    expect(plan!.transitionDur).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('returns null when almost no audible tail remains on A', () => {
    expect(computeAutodjManualBlendPlan(loudBins(), 100, 99.95, loudBins(), 100)).toBeNull();
  });

  it('returns null when a waveform is missing', () => {
    expect(computeAutodjManualBlendPlan(null, 100, 50, loudBins(), 100)).toBeNull();
    expect(computeAutodjManualBlendPlan(loudBins(), 100, 50, undefined, 100)).toBeNull();
  });

  it('returns null for non-positive durations', () => {
    expect(computeAutodjManualBlendPlan(loudBins(), 0, 50, loudBins(), 100)).toBeNull();
  });
});
