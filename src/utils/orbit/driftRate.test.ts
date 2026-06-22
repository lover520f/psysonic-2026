import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, syncToRust } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  syncToRust: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../store/playbackRateStore', () => ({
  usePlaybackRateStore: { getState: () => ({ syncToRust }) },
}));

import {
  applyOrbitDriftRate,
  orbitDriftRateLastSent,
  resetOrbitDriftRate,
} from './driftRate';

beforeEach(() => {
  resetOrbitDriftRate(); // clear module-level lastSentRate between tests
  invoke.mockClear();
  syncToRust.mockClear();
});

describe('applyOrbitDriftRate', () => {
  it('sends a pitch-corrected speed for a non-neutral rate', () => {
    applyOrbitDriftRate(1.05);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('audio_set_playback_rate', {
      enabled: true,
      strategy: 'speed_corrected',
      speed: 1.05,
      pitchSemitones: 0,
    });
    expect(orbitDriftRateLastSent()).toBe(1.05);
  });

  it('disables the DSP at exactly 1.0× (true passthrough)', () => {
    applyOrbitDriftRate(1.0);
    expect(invoke).toHaveBeenCalledWith('audio_set_playback_rate', {
      enabled: false,
      strategy: 'speed_corrected',
      speed: 1.0,
      pitchSemitones: 0,
    });
  });

  it('de-dupes identical consecutive rates (no redundant IPC)', () => {
    applyOrbitDriftRate(1.03);
    applyOrbitDriftRate(1.03);
    applyOrbitDriftRate(1.03);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends again when the rate actually changes', () => {
    applyOrbitDriftRate(1.01);
    applyOrbitDriftRate(1.02);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('clamps to the ±10% product cap', () => {
    applyOrbitDriftRate(1.5);
    expect(invoke).toHaveBeenLastCalledWith('audio_set_playback_rate', expect.objectContaining({ speed: 1.1 }));
    applyOrbitDriftRate(0.5);
    expect(invoke).toHaveBeenLastCalledWith('audio_set_playback_rate', expect.objectContaining({ speed: 0.9 }));
  });
});

describe('resetOrbitDriftRate', () => {
  it('hands rate control back to the store sync and clears tracking', () => {
    applyOrbitDriftRate(1.07);
    expect(orbitDriftRateLastSent()).toBe(1.07);
    resetOrbitDriftRate();
    expect(syncToRust).toHaveBeenCalled();
    expect(orbitDriftRateLastSent()).toBeNull();
  });

  it('re-sends after a reset even for a rate sent before it', () => {
    applyOrbitDriftRate(1.04);
    invoke.mockClear();
    resetOrbitDriftRate();
    applyOrbitDriftRate(1.04);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
