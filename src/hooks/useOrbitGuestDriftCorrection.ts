import { useEffect } from 'react';

import { useOrbitStore } from '../store/orbitStore';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { estimateLivePosition } from '../api/orbit';
import {
  computeOrbitDriftMs,
  planOrbitDriftCorrection,
  applyOrbitDriftRate,
  resetOrbitDriftRate,
  setOrbitDriftStatus,
  resetOrbitDriftStatus,
  pushDriftSample,
  makeDriftSmoother,
  ORBIT_DRIFT_LOOP_TICK_MS,
  ORBIT_DRIFT_SETTLE_TICKS,
  ORBIT_DRIFT_SMOOTH_WINDOW,
  ORBIT_DRIFT_SMOOTH_MIN_SAMPLES,
} from '../utils/orbit';
import { clampCrossfadeSecs } from '../utils/playback/autodjAutoAdvance';
import { pushOrbitEvent } from '../utils/orbitDiag';

/**
 * Orbit — guest-side drift correction (v3: smoothed bang-bang).
 *
 * Once per `LOOP_TICK_MS`, while we're an active guest playing the host's track,
 * nudge our playback rate toward the host. The raw drift is noisy (it swings
 * ±1500 ms tick-to-tick with no real change), so we **median-smooth** it and act
 * only on the stable value. Correction is **bang-bang**: jump straight to the
 * ±10% cap, hold until caught up, then jump back to 1.0× — far fewer speed
 * switches (which cause artifacts). After every speed change / seek we **settle**
 * (ignore measurements) for a few ticks so a correction can't read back its own
 * perturbation, which is what made the v2 ramp chase its own tail.
 *
 * Mounted from `useOrbitGuest`; does nothing unless `active`.
 */
export function useOrbitGuestDriftCorrection(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let timer: number | null = null;
    let currentRate = 1.0;
    let settleTicks = 0;
    let lastAction: string | null = null;
    const smoother = makeDriftSmoother(ORBIT_DRIFT_SMOOTH_WINDOW, ORBIT_DRIFT_SMOOTH_MIN_SAMPLES);

    const note = (action: string, detail: string) => {
      if (action !== lastAction) {
        pushOrbitEvent('drift-correction', `${action}: ${detail}`);
        lastAction = action;
      }
    };

    /** Abort to neutral (pause / track change / teardown). No settle — we stop. */
    const resetToNeutral = (reason: string) => {
      if (currentRate === 1.0 && lastAction === null && settleTicks === 0) return;
      note('reset', reason);
      lastAction = null;
      currentRate = 1.0;
      settleTicks = 0;
      smoother.reset();
      resetOrbitDriftRate();
      resetOrbitDriftStatus();
    };

    /**
     * Set the engine rate. A real change is a correction action: settle and drop
     * buffered samples so the next measurement isn't the engine's transient.
     */
    const setRate = (rate: number) => {
      if (Math.abs(rate - currentRate) < 1e-9) return;
      currentRate = rate;
      applyOrbitDriftRate(rate);
      smoother.reset();
      settleTicks = ORBIT_DRIFT_SETTLE_TICKS;
    };

    const step = () => {
      const state = useOrbitStore.getState().state;
      const player = usePlayerStore.getState();

      // ── Abort guards → neutral ──
      if (!state?.currentTrack || !player.currentTrack) { resetToNeutral('no track'); return; }
      const hostTrackId = state.currentTrack.trackId;
      if (player.currentTrack.id !== hostTrackId) { resetToNeutral('different track'); return; }
      if (!player.isPlaying || !state.isPlaying) { resetToNeutral('paused'); return; }

      const now = Date.now();
      const durationSec = player.currentTrack.duration;
      const trackDurationMs = durationSec * 1000;
      const hostPositionMs = estimateLivePosition(state, now);
      const tTrackRemSec = (trackDurationMs - hostPositionMs) / 1000;

      // ── Blend guard ──
      // Hold 1.0× through a crossfade / AutoDJ smooth-skip blend near the track
      // end. Gapless has no overlap, so no guard.
      const a = useAuthStore.getState();
      let blendGuardSec = 0;
      if (a.crossfadeEnabled) blendGuardSec = clampCrossfadeSecs(a.crossfadeSecs);
      if (a.autodjSmoothSkip) blendGuardSec = Math.max(blendGuardSec, 2);
      if (blendGuardSec > 0) blendGuardSec += 2;
      if (blendGuardSec > 0 && tTrackRemSec <= blendGuardSec) {
        setRate(1.0);
        setOrbitDriftStatus({ action: 'blend', currentRate, smoothedDriftMs: smoother.value() });
        note('blend-guard', `holding 1.0× for blend, ${tTrackRemSec.toFixed(1)}s left`);
        return;
      }

      // ── Settle window after a speed change / seek ──
      // Hold the current rate and don't measure — the engine is still settling,
      // so a measurement here would read the perturbation and we'd chase it.
      if (settleTicks > 0) {
        settleTicks -= 1;
        setOrbitDriftStatus({ action: 'settle', currentRate, smoothedDriftMs: smoother.value() });
        return;
      }

      const guestPosMs = (player.currentTime ?? 0) * 1000;
      const rawDrift = computeOrbitDriftMs(state, guestPosMs, now);
      smoother.push(rawDrift);
      const smoothed = smoother.value();

      // Continuous trace (raw + smoothed) for the CSV diagnostics export.
      pushDriftSample({
        ts: now,
        driftMs: rawDrift,
        smoothedMs: smoothed,
        rate: currentRate,
        action: lastAction ?? 'idle',
        trackRemSec: tTrackRemSec,
        hostPosMs: hostPositionMs,
        guestPosMs,
      });

      // Window not full yet → wait, holding whatever rate we're on.
      if (smoothed === null) {
        setOrbitDriftStatus({ action: currentRate === 1.0 ? 'hold' : 'correct', currentRate, smoothedDriftMs: null });
        return;
      }

      const plan = planOrbitDriftCorrection({
        driftMs: smoothed,
        trackRemSec: tTrackRemSec,
        hostIsPlaying: state.isPlaying,
        correcting: currentRate !== 1.0,
      });

      if (plan.action === 'seek') {
        const fraction = Math.max(0, Math.min(0.99, (hostPositionMs / 1000) / Math.max(1, durationSec)));
        note('seek', `smoothed drift ${Math.round(smoothed)}ms uncorrectable, seeking`);
        player.seek(fraction);
        currentRate = 1.0;
        resetOrbitDriftRate();
        smoother.reset();
        settleTicks = ORBIT_DRIFT_SETTLE_TICKS;
        setOrbitDriftStatus({ action: 'seek', currentRate: 1.0, smoothedDriftMs: smoothed });
        return;
      }

      if (plan.action === 'correct') {
        setRate(plan.rate);
        setOrbitDriftStatus({ action: 'correct', currentRate, smoothedDriftMs: smoothed });
        note('correct', `smoothed drift ${Math.round(smoothed)}ms → rate ${plan.rate.toFixed(2)}×`);
      } else {
        setRate(1.0);
        setOrbitDriftStatus({ action: 'hold', currentRate, smoothedDriftMs: smoothed });
        note('hold', `smoothed drift ${Math.round(smoothed)}ms within band`);
      }
    };

    const tick = () => {
      timer = null;
      if (cancelled) return;
      try { step(); } catch { /* best-effort; retry next tick */ }
      if (!cancelled) timer = window.setTimeout(tick, ORBIT_DRIFT_LOOP_TICK_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      resetOrbitDriftRate();
      resetOrbitDriftStatus();
    };
  }, [active]);
}
