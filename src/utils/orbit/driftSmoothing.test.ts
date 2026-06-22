import { describe, expect, it } from 'vitest';

import { makeDriftSmoother, median } from './driftSmoothing';

describe('median', () => {
  it('returns the middle of an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('averages the two middle values of an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('rejects a single spike (the whole point)', () => {
    // Four samples around -1000 plus one +480 spike → median stays near -1000.
    expect(median([-1008, -1029, 480, -1034, -1008])).toBe(-1008);
  });
  it('handles an empty list', () => {
    expect(median([])).toBe(0);
  });
});

describe('makeDriftSmoother', () => {
  it('returns null until minSamples have arrived', () => {
    const s = makeDriftSmoother(5, 3);
    s.push(-1000);
    expect(s.value()).toBeNull();
    s.push(-1010);
    expect(s.value()).toBeNull();
    s.push(-990);
    expect(s.value()).not.toBeNull();
  });

  it('smooths the real oscillating sequence to a stable value', () => {
    // The exact alternating sequence from the bug log.
    const s = makeDriftSmoother(5, 3);
    for (const v of [-1008, 483, -1029, 483, -1034]) s.push(v);
    // Median of the window ignores the +483 spikes → stays clearly "behind".
    expect(s.value()).toBeLessThan(-500);
  });

  it('drops the oldest sample past the window size', () => {
    const s = makeDriftSmoother(3, 1);
    s.push(100);
    s.push(200);
    s.push(300);
    s.push(400); // evicts 100
    expect(s.size()).toBe(3);
    expect(s.value()).toBe(300); // median of [200,300,400]
  });

  it('reset clears the buffer and re-arms the minSamples gate', () => {
    const s = makeDriftSmoother(5, 3);
    s.push(1); s.push(2); s.push(3);
    expect(s.value()).not.toBeNull();
    s.reset();
    expect(s.size()).toBe(0);
    expect(s.value()).toBeNull();
  });
});
