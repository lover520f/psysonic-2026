import { describe, expect, it } from 'vitest';
import {
  WAVEFORM_GAMMA,
  analyzeEdge,
  detectWaveformEncoding,
  normU8,
  planEdgeMix,
  planEdgeMixForSkip,
  unGammaToAmplitude,
} from './autodjEdgeMix';

// ── Synthetic waveform helpers (PCM percentile path: bin = 8 + t^gamma * 247) ──
const N = 500;
const DUR = 240; // 4 min → sec_per_bin = 0.48

function pcmBinForT(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return Math.round(8 + Math.pow(clamped, WAVEFORM_GAMMA) * 247);
}

/** Constant amplitude `t` across the whole track. */
function constBins(t: number, n = N): number[] {
  return new Array(n).fill(pcmBinForT(t));
}

/** Linear ramp in amplitude `t` from start (bin 0) to end (last bin). */
function rampBins(tStart: number, tEnd: number, n = N): number[] {
  return Array.from({ length: n }, (_, i) => pcmBinForT(tStart + (tEnd - tStart) * (i / (n - 1))));
}

/** Loud content with `padBins` of trim-silence (bin 8 ≤ cut) on the given side(s). */
function paddedLoud(side: 'start' | 'end' | 'both', padBins = 10, n = N): number[] {
  const bins = new Array(n).fill(pcmBinForT(1));
  if (side === 'start' || side === 'both') for (let i = 0; i < padBins; i++) bins[i] = 8;
  if (side === 'end' || side === 'both') for (let i = 0; i < padBins; i++) bins[n - 1 - i] = 8;
  return bins;
}

describe('normU8 / encoding (§16.1 G1)', () => {
  it('maps the PCM percentile range 8…255 to [0,1]', () => {
    expect(normU8(8, 'pcm_u8')).toBeCloseTo(0, 6);
    expect(normU8(255, 'pcm_u8')).toBeCloseTo(1, 6);
  });

  it('places the documented 0.9 reference between bins 230 and 231', () => {
    expect(normU8(230, 'pcm_u8')).toBeLessThan(0.9);
    expect(normU8(230, 'pcm_u8')).toBeCloseTo(0.899, 2);
    expect(normU8(231, 'pcm_u8')).toBeGreaterThan(0.9);
  });

  it('maps the byte-envelope fallback range 0…255 to [0,1]', () => {
    expect(normU8(0, 'byte_envelope')).toBeCloseTo(0, 6);
    expect(normU8(255, 'byte_envelope')).toBeCloseTo(1, 6);
  });

  it('detects encoding from the peak floor (min < 8 → byte-envelope)', () => {
    expect(detectWaveformEncoding([0, 128, 255, 64])).toBe('byte_envelope');
    expect(detectWaveformEncoding([8, 100, 255, 40])).toBe('pcm_u8');
    expect(detectWaveformEncoding([])).toBe('pcm_u8');
  });

  it('un-gammas norm_u8 to linear amplitude t = norm^(1/gamma)', () => {
    // norm_u8 ≈ 0.9 ⇒ t ≈ 0.82 of the track's own range (§16.7).
    expect(unGammaToAmplitude(0.9)).toBeCloseTo(Math.pow(0.9, 1 / WAVEFORM_GAMMA), 6);
    expect(unGammaToAmplitude(0.9)).toBeCloseTo(0.82, 2);
    expect(unGammaToAmplitude(1)).toBeCloseTo(1, 6);
    expect(unGammaToAmplitude(0)).toBeCloseTo(0, 6);
  });
});

describe('analyzeEdge — duration & shape (§3)', () => {
  it('returns null for missing bins or invalid duration', () => {
    expect(analyzeEdge(null, DUR, 'end')).toBeNull();
    expect(analyzeEdge(undefined, DUR, 'start')).toBeNull();
    expect(analyzeEdge(constBins(1), 0, 'end')).toBeNull();
    expect(analyzeEdge(constBins(1), Number.NaN, 'end')).toBeNull();
    expect(analyzeEdge([1, 2, 3], DUR, 'end')).toBeNull(); // wrong length → coerce null
  });

  it('loud-throughout end edge saturates to max_duration with y0 ≈ 1', () => {
    const edge = analyzeEdge(constBins(1), DUR, 'end');
    expect(edge).not.toBeNull();
    expect(edge!.shape.seconds).toBeCloseTo(12, 5); // max_duration
    expect(edge!.shape.y0).toBeCloseTo(1, 2);
  });

  it('self-fading outro → short end edge (min_duration) with y0 ≈ 0 (scenario A)', () => {
    const edge = analyzeEdge(rampBins(1, 0), DUR, 'end');
    expect(edge).not.toBeNull();
    expect(edge!.shape.seconds).toBeCloseTo(0.5, 1); // min_duration after clamp
    expect(edge!.shape.y0).toBeLessThan(0.1);
  });

  it('quiet fade-in intro → short start edge (min_duration) with y0 ≈ 0', () => {
    const edge = analyzeEdge(rampBins(0, 1), DUR, 'start');
    expect(edge).not.toBeNull();
    expect(edge!.shape.seconds).toBeCloseTo(0.5, 1);
    expect(edge!.shape.y0).toBeLessThan(0.1);
  });

  it('hard-start intro → long start edge with y0 ≈ 1', () => {
    const edge = analyzeEdge(constBins(1), DUR, 'start');
    expect(edge).not.toBeNull();
    expect(edge!.shape.seconds).toBeCloseTo(12, 5);
    expect(edge!.shape.y0).toBeCloseTo(1, 2);
  });

  it('anchors at the content edge — trimmed lead/trail silence does not collapse the edge', () => {
    // Regression: walking from the raw physical bin stopped instantly in the
    // trimmed silence → every edge became min_duration → near-gapless overlaps.
    const startEdge = analyzeEdge(paddedLoud('start'), DUR, 'start');
    expect(startEdge!.shape.seconds).toBeGreaterThan(2);
    expect(startEdge!.shape.y0).toBeCloseTo(1, 1);

    const endEdge = analyzeEdge(paddedLoud('end'), DUR, 'end');
    expect(endEdge!.shape.seconds).toBeGreaterThan(2);
    expect(endEdge!.shape.y0).toBeCloseTo(1, 1);
  });

  it('silence-only track → raw 0 → min_duration, y0 ≈ 0 (fallback threshold path)', () => {
    const edge = analyzeEdge(constBins(0), DUR, 'end');
    expect(edge).not.toBeNull();
    expect(edge!.shape.seconds).toBeCloseTo(0.5, 1);
    expect(edge!.shape.y0).toBeLessThan(0.05);
  });

  it('always clamps shape endpoints to [0,1] (clamp-refit)', () => {
    for (const bins of [rampBins(0, 1), rampBins(1, 0), constBins(0.6), constBins(1)]) {
      for (const side of ['start', 'end'] as const) {
        const edge = analyzeEdge(bins, DUR, side);
        expect(edge!.shape.y0).toBeGreaterThanOrEqual(0);
        expect(edge!.shape.y0).toBeLessThanOrEqual(1);
        expect(edge!.shape.y1).toBeGreaterThanOrEqual(0);
        expect(edge!.shape.y1).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('planEdgeMix — end-of-track AutoDJ (§4)', () => {
  it('returns null when either waveform is missing (never partial)', () => {
    expect(planEdgeMix(null, DUR, DUR, constBins(1), DUR, 0, DUR)).toBeNull();
    expect(planEdgeMix(constBins(1), DUR, DUR, null, DUR, 0, DUR)).toBeNull();
  });

  it('produces a decreasing g_A and increasing g_B with the §4.2 fixed endpoints', () => {
    const plan = planEdgeMix(constBins(1), DUR, DUR, constBins(1), DUR, 0, DUR);
    expect(plan).not.toBeNull();
    // Fixed endpoints required by the IPC contract.
    expect(plan!.outgoingGainAtMixStart).toBeCloseTo(1, 6);
    expect(plan!.incomingGainAtMixEnd).toBeCloseTo(1, 6);
    // g_A decreases over the mix; g_B increases.
    expect(plan!.outgoingGainAtMixStart).toBeGreaterThanOrEqual(plan!.outgoingGainAtMixEnd);
    expect(plan!.incomingGainAtMixStart).toBeLessThanOrEqual(plan!.incomingGainAtMixEnd);
    for (const g of [
      plan!.outgoingGainAtMixEnd,
      plan!.incomingGainAtMixStart,
    ]) {
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });

  it('transition_dur = min(edges), capped to the playable window', () => {
    // A self-fades (end edge ≈ 0.5 s); B hard-starts (start edge ≈ 12 s) → min ≈ 0.5.
    const plan = planEdgeMix(rampBins(1, 0), DUR, DUR, constBins(1), DUR, 0, DUR);
    expect(plan).not.toBeNull();
    expect(plan!.transitionDur).toBeCloseTo(0.5, 1);
    expect(plan!.bStartSec).toBe(0);
  });

  it('scenario A: self-fading outro keeps outgoing gain high at mix end (not forced to 0)', () => {
    const fade = planEdgeMix(rampBins(1, 0), DUR, DUR, constBins(1), DUR, 0, DUR);
    expect(fade!.outgoingGainAtMixEnd).toBeGreaterThan(0.8);

    // Hard loud cut → engine must fully duck A by mix end.
    const hard = planEdgeMix(constBins(1), DUR, DUR, constBins(1), DUR, 0, DUR);
    expect(hard!.outgoingGainAtMixEnd).toBeLessThan(0.05);
  });

  it('two loud tracks padded with edge silence still blend over a real overlap (not gapless)', () => {
    // A ends loud (with trailing silence trimmed); B starts loud (leading silence
    // trimmed). Content bounds come from the silence layer; the blend must be a
    // multi-second musical overlap, not a min_duration cut.
    const plan = planEdgeMix(paddedLoud('end'), DUR, 235.2, paddedLoud('start'), DUR, 4.8, DUR);
    expect(plan).not.toBeNull();
    expect(plan!.transitionDur).toBeGreaterThan(2);
    expect(plan!.outgoingGainAtMixEnd).toBeLessThan(0.05); // loud A fully ducks
    expect(plan!.incomingGainAtMixStart).toBeLessThan(0.05); // loud B rises from ~0
  });

  it('documents the linear-sum clipping risk: g_A(0) + g_B(0) can exceed 1 (§10.5)', () => {
    // Loud outgoing A + quiet-intro B (linear_B(0) ≈ 0 → incoming_start ≈ 1).
    const plan = planEdgeMix(constBins(1), DUR, DUR, rampBins(0, 1), DUR, 0, DUR);
    expect(plan).not.toBeNull();
    expect(plan!.incomingGainAtMixStart).toBeGreaterThan(0.8);
    const sumAtStart = plan!.outgoingGainAtMixStart + plan!.incomingGainAtMixStart;
    expect(sumAtStart).toBeGreaterThan(1);
  });
});

describe('planEdgeMixForSkip — manual mid-track skip (§10.6)', () => {
  it('mid-track loud skip fully ducks the outgoing track and caps the blend', () => {
    const plan = planEdgeMixForSkip(constBins(1), DUR, 60, constBins(1), DUR);
    expect(plan).not.toBeNull();
    expect(plan!.outgoingGainAtMixEnd).toBe(0); // engine fades A out fully
    expect(plan!.transitionDur).toBeLessThanOrEqual(2.0); // MANUAL_SKIP_MAX_BLEND_SEC
    expect(plan!.transitionDur).toBeGreaterThan(0);
  });

  it('skip inside a sustained outro lets A ride its own end-edge shape', () => {
    // Constant moderate level → end edge stays above the plateau-relative threshold
    // (long edge), y0 ≈ 0.6 → outgoing_gain_end ≈ 0.4.
    const plan = planEdgeMixForSkip(constBins(0.6), DUR, 238, constBins(1), DUR);
    expect(plan).not.toBeNull();
    expect(plan!.outgoingGainAtMixEnd).toBeCloseTo(0.4, 1);
  });

  it('returns null when too little of A remains from the skip point', () => {
    expect(planEdgeMixForSkip(constBins(1), DUR, 239.9, constBins(1), DUR)).toBeNull();
  });

  it('returns null when a waveform is missing', () => {
    expect(planEdgeMixForSkip(null, DUR, 60, constBins(1), DUR)).toBeNull();
    expect(planEdgeMixForSkip(constBins(1), DUR, 60, undefined, DUR)).toBeNull();
  });
});
