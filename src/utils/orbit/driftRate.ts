/**
 * Orbit drift-rate channel — the carve-out that lets the guest drift loop drive
 * `audio_set_playback_rate` *during* a session even though the user's own
 * playback-rate preference is suppressed by `syncPlaybackRate`
 * (`effectiveEnabled = enabled && !isOrbitPlaybackSyncActive()`).
 *
 * This path never touches the persisted `playbackRateStore` prefs — it sends a
 * pitch-corrected speed straight to the engine and, on reset, hands control
 * back to the store's own sync (which yields a neutral 1.0× while the session
 * is active, or the restored user pref once it has ended).
 *
 * Calls are de-duplicated against the last value actually sent so the 500 ms
 * loop only hits IPC when the rate genuinely changes.
 */

import { invoke } from '@tauri-apps/api/core';

import { usePlaybackRateStore } from '../../store/playbackRateStore';
import { RATE_MAX, RATE_MIN } from './driftCorrectionConstants';

/** Engine strategy for pitch-corrected speed — the same one the user "speed" mode maps to. */
const ORBIT_DRIFT_STRATEGY = 'speed_corrected';

let lastSentRate: number | null = null;

function clampRate(rate: number): number {
  return Math.max(RATE_MIN, Math.min(RATE_MAX, rate));
}

/**
 * Push a correction rate to the engine. At exactly 1.0× we disable the DSP
 * (true passthrough / bit-perfect) rather than running a neutral effect.
 * No-ops when the value is unchanged from the last send.
 */
export function applyOrbitDriftRate(rate: number): void {
  const clamped = clampRate(rate);
  if (lastSentRate !== null && Math.abs(lastSentRate - clamped) < 1e-6) return;
  lastSentRate = clamped;
  const enabled = Math.abs(clamped - 1) > 1e-9;
  invoke('audio_set_playback_rate', {
    enabled,
    strategy: ORBIT_DRIFT_STRATEGY,
    speed: enabled ? clamped : 1.0,
    pitchSemitones: 0,
  }).catch(() => {});
}

/**
 * Relinquish the drift channel and restore the correct steady-state rate.
 * Delegates to the store's own `syncToRust`, which sends a neutral 1.0× while
 * the Orbit session is still active and the real user pref once it has ended —
 * so this is safe to call both mid-session (track change, seek, pause) and on
 * leave. Idempotent.
 */
export function resetOrbitDriftRate(): void {
  if (lastSentRate === null) {
    // Never engaged the channel this cycle — still re-assert the baseline once
    // so a stale engine rate from a prior correction can't linger.
    usePlaybackRateStore.getState().syncToRust();
    return;
  }
  lastSentRate = null;
  usePlaybackRateStore.getState().syncToRust();
}

/** Test-only: the last rate pushed to the engine (null after a reset). */
export function orbitDriftRateLastSent(): number | null {
  return lastSentRate;
}
