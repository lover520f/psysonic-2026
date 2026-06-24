/**
 * AutoDJ edge-mix — waveform-driven linear blend (algorithm by Ivan Pelipenko,
 * @peri4ko). Each track boundary ("edge") is analysed from the *existing* cached
 * waveform bins: an edge has a duration and a clamped linear envelope. At mix
 * time we derive effective linear gain curves for the outgoing and incoming
 * track, the engine multiplies samples and sums (no equal-power sin/cos on the
 * AutoDJ path).
 *
 * This module is the pure, testable core (no Tauri/store deps). It does NOT do
 * silence trimming — that stays in `waveformSilence.ts` and is an orthogonal
 * layer; we only consume its content bounds for feasibility caps.
 *
 * Waveform domain (important): the cached bins are NOT linear [0,1] amplitude.
 * `normalize_peak_bins` (psysonic-analysis) applies per-track percentile
 * (p5→8, p99→255) and a gamma of 0.52 before storage, so `normU8` is perceptual.
 * Edge math therefore un-gammas to a linear amplitude `t = normU8^(1/gamma)` and
 * uses a plateau-relative threshold rather than a fixed absolute 0.9. See the
 * task spec §16.1 / §16.7 for the full rationale.
 */
import { coerceWaveformBins } from './waveformParse';
import { computeWaveformSilence, peakHalf } from './waveformSilence';

/** Gamma applied by `normalize_peak_bins` before storage (perceptual shaping). */
export const WAVEFORM_GAMMA = 0.52;

/** PCM percentile path floors silence at this u8; byte-envelope can emit 0. */
const PCM_FLOOR = 8;

const DEFAULT_MIN_DURATION = 0.5;
const DEFAULT_MAX_DURATION = 12.0;
/** Threshold = `plateauFactor * plateau_t` (fraction of the track's own plateau). */
const DEFAULT_PLATEAU_FACTOR = 0.8;
/** Lower clamp on the plateau-relative threshold (and floor when plateau usable). */
const DEFAULT_ABS_FLOOR_T = 0.3;
/** Upper clamp on the plateau-relative threshold. */
const THRESHOLD_T_CAP = 0.95;
/** Absolute fallback (on `normU8`) when the plateau cannot be computed. */
const DEFAULT_THRESHOLD_NORM_U8 = 0.9;
/** Bins with `t` below this are treated as silence for the plateau percentile. */
const PLATEAU_SILENCE_FLOOR_T = 0.05;
/** Don't let the overlap eat more than this fraction of the shorter content window. */
const SUSTAINABLE_FACTOR = 0.9;
/** Manual mid-track skip: cap loud A lingering over a quiet B intro. */
const MANUAL_SKIP_MAX_BLEND_SEC = 2.0;
/** A's own outro fade must be at least this long to be trusted (scenario A). */
const OWN_FADE_TRUST_SEC = 1.0;

export type WaveformEncoding = 'pcm_u8' | 'byte_envelope';

/** Edge linear shape after clamp-refit. Mix uses `y0` + `seconds` only (`y1` is debug). */
export interface EdgeShape {
  /** Edge span in seconds (after clamp to [min,max]). */
  seconds: number;
  /** linear(0) — un-gamma'd amplitude at the physical edge, clamped to [0,1]. */
  y0: number;
  /** linear(seconds) — clamped to [0,1]; shape/debug only, not passed to the mix. */
  y1: number;
}

export interface AnalyzedEdge {
  side: 'start' | 'end';
  shape: EdgeShape;
}

/** Tunables; defaults locked in the task spec §16.7 G7. Sweepable for calibration. */
export interface EdgeAnalysisOptions {
  minDuration?: number;
  maxDuration?: number;
  /** Un-gamma exponent base; defaults to {@link WAVEFORM_GAMMA}. */
  gamma?: number;
  /** Threshold = plateauFactor * plateau_t. */
  plateauFactor?: number;
  /** Floor/clamp for the plateau-relative threshold (in `t` space). */
  absFloorT?: number;
  /** Absolute fallback threshold on `normU8` when no plateau. */
  thresholdNormU8?: number;
}

/** Per-transition plan handed to the engine (ephemeral, like CrossfadeTransitionPlan). */
export interface EdgeMixPlan {
  /** Mix overlap length (seconds). */
  transitionDur: number;
  /** Always 1.0 — outgoing starts the mix at full engine gain. */
  outgoingGainAtMixStart: number;
  /** 1 - linear_A(0) — may stay > 0 (old not forced to silence; scenario A). */
  outgoingGainAtMixEnd: number;
  /** 1 - linear_B(0) — may be > 0 (new may not start from 0). */
  incomingGainAtMixStart: number;
  /** Always 1.0 — new must exit the mix at full engine gain. */
  incomingGainAtMixEnd: number;
  /** Silence-trim B seek (unchanged source). */
  bStartSec: number;
}

/**
 * Build {@link EdgeAnalysisOptions} duration bounds from the user's AutoDJ
 * transition-length settings. `0` (or any non-positive value) on either bound is
 * the "Auto" sentinel → that bound is left unset so the algorithm keeps its
 * built-in default. A set min that exceeds a set max is collapsed to the max so
 * the window never inverts.
 */
export function edgeDurationOptionsFromSettings(
  minTransitionSec: number,
  maxTransitionSec: number,
): EdgeAnalysisOptions {
  const opts: EdgeAnalysisOptions = {};
  const min = Number.isFinite(minTransitionSec) && minTransitionSec > 0 ? minTransitionSec : undefined;
  const max = Number.isFinite(maxTransitionSec) && maxTransitionSec > 0 ? maxTransitionSec : undefined;
  if (max != null) opts.maxDuration = max;
  if (min != null) opts.minDuration = max != null ? Math.min(min, max) : min;
  return opts;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Detect waveform encoding from the peak half (G1). */
export function detectWaveformEncoding(peak: number[]): WaveformEncoding {
  if (peak.length === 0) return 'pcm_u8';
  let min = peak[0];
  for (let i = 1; i < peak.length; i++) if (peak[i] < min) min = peak[i];
  return min < PCM_FLOOR ? 'byte_envelope' : 'pcm_u8';
}

/** Map one bin to the stored (gamma'd, perceptual) [0,1] value (G1). */
export function normU8(bin: number, encoding: WaveformEncoding): number {
  return encoding === 'byte_envelope'
    ? clamp01(bin / 255)
    : clamp01((bin - PCM_FLOOR) / (255 - PCM_FLOOR));
}

/** Un-gamma a stored value to linear percentile amplitude `t` (§16.7). */
export function unGammaToAmplitude(normValue: number, gamma = WAVEFORM_GAMMA): number {
  return Math.pow(clamp01(normValue), 1 / gamma);
}

function binToAmplitude(bin: number, encoding: WaveformEncoding, gamma: number): number {
  return unGammaToAmplitude(normU8(bin, encoding), gamma);
}

/** 75th-percentile of above-floor amplitudes — the track's own "plateau" level. */
function plateauAmplitude(tValues: number[]): number {
  const loud: number[] = [];
  for (const t of tValues) if (t > PLATEAU_SILENCE_FLOOR_T) loud.push(t);
  if (loud.length === 0) return 0;
  loud.sort((a, b) => a - b);
  return loud[Math.min(loud.length - 1, Math.floor(loud.length * 0.75))];
}

/** Least-squares line `y = a*t + b` over points (slope 0 for a single point). */
function fitLine(points: { t: number; y: number }[]): { a: number; b: number } {
  const n = points.length;
  if (n <= 1) return { a: 0, b: n === 1 ? points[0].y : 0 };
  let sumT = 0;
  let sumY = 0;
  let sumTT = 0;
  let sumTY = 0;
  for (const p of points) {
    sumT += p.t;
    sumY += p.y;
    sumTT += p.t * p.t;
    sumTY += p.t * p.y;
  }
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-9) return { a: 0, b: sumY / n };
  const a = (n * sumTY - sumT * sumY) / denom;
  const b = (sumY - a * sumT) / n;
  return { a, b };
}

/**
 * Analyse one edge of a track. `side='start'` walks inward from the content
 * start; `side='end'` walks backward from the content end (both from the
 * silence-trimmed boundary, not the raw file edge). The span is the adjacent
 * loud run for a hard edge, or the natural fade/rise envelope when the boundary
 * is below threshold. Returns null when bins are missing/invalid or duration is
 * non-positive.
 */
export function analyzeEdge(
  bins: number[] | null | undefined,
  durationSec: number,
  side: 'start' | 'end',
  opts: EdgeAnalysisOptions = {},
): AnalyzedEdge | null {
  const coerced = coerceWaveformBins(bins);
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!coerced || dur <= 0) return null;

  const peak = peakHalf(coerced);
  const n = peak.length;
  if (n === 0) return null;

  const minDuration = Math.max(0.01, opts.minDuration ?? DEFAULT_MIN_DURATION);
  const maxDuration = Math.max(minDuration, opts.maxDuration ?? DEFAULT_MAX_DURATION);
  const gamma = opts.gamma && opts.gamma > 0 ? opts.gamma : WAVEFORM_GAMMA;
  const plateauFactor = opts.plateauFactor ?? DEFAULT_PLATEAU_FACTOR;
  const absFloorT = opts.absFloorT ?? DEFAULT_ABS_FLOOR_T;
  const thresholdNormU8 = opts.thresholdNormU8 ?? DEFAULT_THRESHOLD_NORM_U8;

  const encoding = detectWaveformEncoding(peak);
  const tValues = peak.map(b => binToAmplitude(b, encoding, gamma));

  // Plateau-relative threshold (un-gamma'd amplitude domain). Fallback to the
  // absolute normU8 threshold (also un-gamma'd) when no usable plateau exists.
  const plateau = plateauAmplitude(tValues);
  const thresholdT =
    plateau > 0
      ? clamp(plateauFactor * plateau, absFloorT, THRESHOLD_T_CAP)
      : unGammaToAmplitude(thresholdNormU8, gamma);

  const secPerBin = dur / n;

  // Anchor the edge at the *content* boundary, not the raw file edge. Leading /
  // trailing digital silence is trimmed by the orthogonal silence layer (B is
  // even seeked to `bStartSec`), so walking the loud run from bin 0 / bin n-1
  // would stop immediately inside that silence and collapse essentially every
  // edge to `min_duration` — a tiny overlap that plays like gapless. Walking
  // from the trimmed content edge makes the run reflect the actual music
  // approaching the boundary. (§10.2's "quiet intro → min_duration" still holds:
  // that is genuinely soft *content*, distinct from trimmed silence.)
  const silence = computeWaveformSilence(coerced, dur);
  const contentStartBin = clamp(Math.round(silence.contentStartSec / secPerBin), 0, n - 1);
  const contentEndBin = clamp(Math.round(silence.contentEndSec / secPerBin), contentStartBin + 1, n);

  // Step 1 — edge transition span from the content edge → raw duration. The
  // boundary bin is either at/above the loud threshold or below it, and the two
  // cases call for different spans:
  //   • Hard edge (boundary loud): measure the contiguous *loud run* — the room
  //     the engine has to fade A out / fade B in over solid material.
  //   • Natural fade-out / fade-in (boundary below threshold): measure the
  //     *envelope run* back to where the signal reaches the loud body, so B
  //     rises over A's own recorded fade (scenario A) instead of the mix
  //     collapsing to min_duration and switching only once A is already silent.
  // The boundary bin belongs to exactly one case, so there is no double count.
  const loudAt = (idx: number) => tValues[idx] >= thresholdT;
  const edgeBin = side === 'start' ? contentStartBin : contentEndBin - 1;
  const step = side === 'start' ? 1 : -1;
  const past = (idx: number) => (side === 'start' ? idx >= contentEndBin : idx < contentStartBin);

  let runBins = 0;
  if (loudAt(edgeBin)) {
    let i = edgeBin;
    while (!past(i) && loudAt(i)) { i += step; runBins++; }
  } else {
    // Walk the quiet envelope until it reaches the loud body. If it never does
    // (whole content below threshold — silent/degenerate track), there is no
    // edge to ride → fall back to the min_duration clamp.
    let i = edgeBin;
    while (!past(i) && !loudAt(i)) { i += step; runBins++; }
    if (past(i)) runBins = 0;
  }
  const rawSeconds = runBins * secPerBin;
  const edgeSeconds = clamp(rawSeconds, minDuration, maxDuration);

  // Step 2 — collect samples over the (possibly forced) edge window, in edge
  // time (t = 0 at the content edge, increasing inward).
  const windowBins = clamp(Math.round(edgeSeconds / secPerBin), 1, n);
  const points: { t: number; y: number }[] = [];
  for (let k = 0; k < windowBins; k++) {
    const binIndex = side === 'start' ? contentStartBin + k : contentEndBin - 1 - k;
    if (binIndex < 0 || binIndex >= n) break;
    points.push({ t: k * secPerBin, y: tValues[binIndex] });
  }

  // First fit (LSQ) → endpoints → clamp y to [0,1] → two-point refit.
  const { a, b } = fitLine(points);
  const y0 = clamp01(b);
  const y1 = clamp01(a * edgeSeconds + b);

  return { side, shape: { seconds: edgeSeconds, y0, y1 } };
}

interface FinalizeInputs {
  aContentStartSec: number;
  aContentEndSec: number;
  bStartSec: number;
  bContentEndSec: number;
  /** Manual skip only: wall-clock on A where the mix begins. */
  mixStartA?: number;
}

/**
 * Cap the maintainer `min(edge)` overlap to the playable content window
 * (§16.2). Returns null only on the manual-skip path when A has too little
 * tail left. `edge.seconds` is never re-clamped here — only `transition_dur`.
 */
function finalizeTransitionDur(
  edgeA: AnalyzedEdge,
  edgeB: AnalyzedEdge,
  io: FinalizeInputs,
  minDuration: number,
  maxDuration: number,
): number | null {
  const raw = Math.min(edgeA.shape.seconds, edgeB.shape.seconds);
  let td = clamp(raw, minDuration, maxDuration);

  const aContentLen = Math.max(0, io.aContentEndSec - io.aContentStartSec);
  const bPlayable = Math.max(0, io.bContentEndSec - io.bStartSec);
  const sustainable = Math.min(aContentLen, bPlayable) * SUSTAINABLE_FACTOR;
  td = Math.min(td, sustainable);

  if (io.mixStartA != null) {
    const aRemaining = Math.max(0, io.aContentEndSec - io.mixStartA);
    if (aRemaining < minDuration) return null;
    td = Math.min(td, aRemaining);
  }

  return Math.max(minDuration, td);
}

function resolveDurations(opts: EdgeAnalysisOptions): { minDuration: number; maxDuration: number } {
  const minDuration = Math.max(0.01, opts.minDuration ?? DEFAULT_MIN_DURATION);
  return { minDuration, maxDuration: Math.max(minDuration, opts.maxDuration ?? DEFAULT_MAX_DURATION) };
}

/**
 * End-of-track AutoDJ plan: outgoing A end edge + incoming B start edge.
 * Returns null when either edge is unavailable (caller degrades to engine
 * crossfade — never a partial plan).
 */
export function planEdgeMix(
  aBins: number[] | null | undefined,
  aDurationSec: number,
  aContentEndSec: number,
  bBins: number[] | null | undefined,
  bDurationSec: number,
  bStartSec: number,
  bContentEndSec: number,
  opts: EdgeAnalysisOptions = {},
): EdgeMixPlan | null {
  const edgeA = analyzeEdge(aBins, aDurationSec, 'end', opts);
  const edgeB = analyzeEdge(bBins, bDurationSec, 'start', opts);
  if (!edgeA || !edgeB) return null;

  const { minDuration, maxDuration } = resolveDurations(opts);
  const aContentStartSec = computeWaveformSilence(aBins, aDurationSec).contentStartSec;

  const transitionDur = finalizeTransitionDur(
    edgeA,
    edgeB,
    { aContentStartSec, aContentEndSec, bStartSec, bContentEndSec },
    minDuration,
    maxDuration,
  );
  if (transitionDur == null) return null;

  return {
    transitionDur,
    outgoingGainAtMixStart: 1,
    outgoingGainAtMixEnd: clamp01(1 - edgeA.shape.y0),
    incomingGainAtMixStart: clamp01(1 - edgeB.shape.y0),
    incomingGainAtMixEnd: 1,
    bStartSec: Math.max(0, bStartSec),
  };
}

/**
 * Manual skip / interrupt blend (§10.6). The track-end edge does not relate to
 * a mid-track skip point, so unless the skip lands inside A's own outro fade we
 * fully duck the outgoing (`outgoingGainAtMixEnd = 0`) and cap the overlap.
 * Returns null when A has too little audible tail left from `skipFromTimeSec`.
 */
export function planEdgeMixForSkip(
  aBins: number[] | null | undefined,
  aDurationSec: number,
  skipFromTimeSec: number,
  bBins: number[] | null | undefined,
  bDurationSec: number,
  opts: EdgeAnalysisOptions = {},
): EdgeMixPlan | null {
  const edgeA = analyzeEdge(aBins, aDurationSec, 'end', opts);
  const edgeB = analyzeEdge(bBins, bDurationSec, 'start', opts);
  if (!edgeA || !edgeB) return null;

  const { minDuration, maxDuration } = resolveDurations(opts);
  const aSilence = computeWaveformSilence(aBins, aDurationSec);
  const bSilence = computeWaveformSilence(bBins, bDurationSec);
  const contentEndA = aSilence.contentEndSec;
  const bStart = bSilence.contentStartSec;

  const inOutroZone = skipFromTimeSec >= contentEndA - Math.max(edgeA.shape.seconds, 0.5);
  const aRidesOwnFade =
    inOutroZone &&
    edgeA.shape.seconds >= OWN_FADE_TRUST_SEC &&
    edgeA.shape.seconds >= edgeB.shape.seconds;

  let transitionDur = finalizeTransitionDur(
    edgeA,
    edgeB,
    {
      aContentStartSec: aSilence.contentStartSec,
      aContentEndSec: contentEndA,
      bStartSec: bStart,
      bContentEndSec: bSilence.contentEndSec,
      mixStartA: Math.max(0, skipFromTimeSec),
    },
    minDuration,
    maxDuration,
  );
  if (transitionDur == null) return null;

  if (!aRidesOwnFade) {
    transitionDur = Math.min(transitionDur, MANUAL_SKIP_MAX_BLEND_SEC);
    if (transitionDur < minDuration) return null;
  }

  return {
    transitionDur,
    outgoingGainAtMixStart: 1,
    outgoingGainAtMixEnd: aRidesOwnFade ? clamp01(1 - edgeA.shape.y0) : 0,
    incomingGainAtMixStart: clamp01(1 - edgeB.shape.y0),
    incomingGainAtMixEnd: 1,
    bStartSec: Math.max(0, bStart),
  };
}
