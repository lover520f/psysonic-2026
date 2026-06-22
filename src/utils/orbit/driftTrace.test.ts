import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearDriftTrace,
  driftTraceCount,
  formatDriftTraceCsv,
  pushDriftSample,
  type DriftSample,
} from './driftTrace';

function sample(over: Partial<DriftSample> = {}): DriftSample {
  return {
    ts: Date.parse('2026-06-22T20:00:00.000Z'),
    driftMs: -812.4,
    smoothedMs: -790,
    rate: 1.1,
    action: 'correct',
    trackRemSec: 118.7,
    hostPosMs: 60_000,
    guestPosMs: 59_188,
    ...over,
  };
}

beforeEach(() => clearDriftTrace());

describe('driftTrace', () => {
  it('is empty until something is sampled', () => {
    expect(driftTraceCount()).toBe(0);
    expect(formatDriftTraceCsv()).toBe('');
  });

  it('formats a header and one rounded row per sample', () => {
    pushDriftSample(sample());
    const csv = formatDriftTraceCsv();
    const [header, row] = csv.split('\n');
    expect(header).toBe('iso_ts,raw_ms,smoothed_ms,rate,action,rem_s,host_ms,guest_ms');
    // raw/smoothed/positions rounded to whole ms; rate to 2 dp; rem to 1 dp.
    expect(row).toBe('2026-06-22T20:00:00.000Z,-812,-790,1.10,correct,118.7,60000,59188');
  });

  it('leaves smoothed empty before the window fills', () => {
    pushDriftSample(sample({ smoothedMs: null }));
    const row = formatDriftTraceCsv().split('\n')[1];
    expect(row).toBe('2026-06-22T20:00:00.000Z,-812,,1.10,correct,118.7,60000,59188');
  });

  it('keeps samples in insertion order', () => {
    pushDriftSample(sample({ driftMs: -800, action: 'correct' }));
    pushDriftSample(sample({ driftMs: -200, action: 'hold' }));
    const rows = formatDriftTraceCsv().split('\n').slice(1);
    expect(rows[0]).toContain(',correct,');
    expect(rows[1]).toContain(',hold,');
  });

  it('caps the ring at 1200 samples, dropping the oldest', () => {
    for (let i = 0; i < 1300; i += 1) pushDriftSample(sample({ driftMs: i }));
    expect(driftTraceCount()).toBe(1200);
    const rows = formatDriftTraceCsv().split('\n').slice(1);
    // First surviving sample is #100 (0..99 dropped), last is #1299.
    expect(rows[0]).toContain(',100,');
    expect(rows[rows.length - 1]).toContain(',1299,');
  });

  it('clears the buffer', () => {
    pushDriftSample(sample());
    clearDriftTrace();
    expect(driftTraceCount()).toBe(0);
    expect(formatDriftTraceCsv()).toBe('');
  });
});
