/**
 * Orbit drift smoothing — turn the noisy raw drift signal into a value the
 * controller can act on.
 *
 * The raw drift (`computeOrbitDriftMs`) is badly noisy: the host's position only
 * lands every ~5 s in coarse quanta, and each correction action perturbs the
 * measured position, so a single tick can swing ±1500 ms with no real change.
 * Acting on each raw value makes the guest chase its own tail (the back-and-forth
 * cucadmuh heard). So we feed raw samples through a small **median** window —
 * median rejects single-tick spikes far better than a mean — and only act on the
 * stable result.
 *
 * After a correction action (rate change / seek) the next few samples are
 * meaningless until the engine settles, so the smoother is reset and ignored for
 * a short settle window (handled by the loop via `reset()`).
 */

/** Median of a non-empty list. Pure; does not mutate the input. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export interface DriftSmoother {
  /** Add a raw drift sample. */
  push(sample: number): void;
  /** Median of the buffered samples, or null until the window has filled. */
  value(): number | null;
  /** Drop all buffered samples (after a correction action / track change). */
  reset(): void;
  /** Test/diagnostics: how many samples are currently buffered. */
  size(): number;
}

/**
 * Rolling median over the last `windowSize` samples. `value()` returns null
 * until at least `minSamples` have arrived, so the controller never acts on a
 * half-empty window right after a reset.
 */
export function makeDriftSmoother(windowSize = 5, minSamples = 3): DriftSmoother {
  const buf: number[] = [];
  return {
    push(sample: number) {
      buf.push(sample);
      if (buf.length > windowSize) buf.splice(0, buf.length - windowSize);
    },
    value() {
      return buf.length >= minSamples ? median(buf) : null;
    },
    reset() {
      buf.length = 0;
    },
    size() {
      return buf.length;
    },
  };
}
