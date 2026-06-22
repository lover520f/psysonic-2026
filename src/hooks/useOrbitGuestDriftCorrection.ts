import { useEffect } from 'react';

import { useOrbitStore } from '../store/orbitStore';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { estimateLivePosition } from '../api/orbit';
import {
  computeOrbitDriftMs,
  planOrbitDriftCorrection,
  stepRateToward,
  applyOrbitDriftRate,
  resetOrbitDriftRate,
  setOrbitDriftStatus,
  resetOrbitDriftStatus,
  ORBIT_DRIFT_LOOP_TICK_MS,
} from '../utils/orbit';
import { clampCrossfadeSecs } from '../utils/playback/autodjAutoAdvance';
import { pushOrbitEvent } from '../utils/orbitDiag';

/**
 * Orbit — guest-side smooth drift correction.
 *
 * Once per `LOOP_TICK_MS`, while we're an active guest playing the host's
 * current track, nudge our playback rate (pitch-preserving, ≤ ±10%) toward the
 * host's live position instead of hard-seeking on every wobble. A pure planner
 * (`planOrbitDriftCorrection`) decides hold / soft / seek from the live drift
 * and the time left in the track; this loop steps the rate one 1% increment per
 * tick toward the planned target and re-plans every tick.
 *
 * The rate goes through the Orbit drift-rate carve-out (`applyOrbitDriftRate`),
 * which is independent of the user's suppressed playback-rate preference and is
 * always handed back to 1.0× / the user pref on any abort.
 *
 * Mounted from `useOrbitGuest`; does nothing unless `active`.
 */
export function useOrbitGuestDriftCorrection(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let timer: number | null = null;
    let currentRate = 1.0;
    let lastAction: string | null = null;

    const note = (action: string, detail: string) => {
      if (action !== lastAction) {
        pushOrbitEvent('drift-correction', `${action}: ${detail}`);
        lastAction = action;
      }
    };

    const resetRate = (reason: string) => {
      // Idempotent: once neutral, do nothing — otherwise a paused or diverged
      // guest (which hits an abort guard every tick) would fire a redundant
      // rate IPC every 500 ms. `lastAction === null` marks "already handed back".
      if (currentRate === 1.0 && lastAction === null) return;
      note('reset', reason);
      lastAction = null;
      currentRate = 1.0;
      resetOrbitDriftRate();
      resetOrbitDriftStatus();
    };

    const step = () => {
      const state = useOrbitStore.getState().state;
      const player = usePlayerStore.getState();

      // ── Abort guards → reset to 1.0× ──
      if (!state?.currentTrack || !player.currentTrack) { resetRate('no track'); return; }
      const hostTrackId = state.currentTrack.trackId;
      if (player.currentTrack.id !== hostTrackId) { resetRate('different track'); return; }
      if (!player.isPlaying || !state.isPlaying) { resetRate('paused'); return; }

      const now = Date.now();
      const durationSec = player.currentTrack.duration;
      const trackDurationMs = durationSec * 1000;
      const hostPositionMs = estimateLivePosition(state, now);
      const tTrackRemSec = (trackDurationMs - hostPositionMs) / 1000;

      // ── Blend guard ──
      // Settle to 1.0× through a crossfade / AutoDJ smooth-skip blend near the
      // track end — a ±10% nudge during an overlap could disturb it (the
      // bit-perfect/blend audit is Phase 2). Gapless has no overlap, so no guard.
      const a = useAuthStore.getState();
      let blendGuardSec = 0;
      if (a.crossfadeEnabled) blendGuardSec = clampCrossfadeSecs(a.crossfadeSecs);
      if (a.autodjSmoothSkip) blendGuardSec = Math.max(blendGuardSec, 2);
      if (blendGuardSec > 0) blendGuardSec += 2; // reach 1.0× before the blend opens
      if (blendGuardSec > 0 && tTrackRemSec <= blendGuardSec) {
        currentRate = stepRateToward(currentRate, 1.0);
        applyOrbitDriftRate(currentRate);
        setOrbitDriftStatus({ action: 'blend', currentRate, targetRate: 1.0, expectedDurationSec: null });
        note('blend-guard', `holding 1.0× for blend, ${tTrackRemSec.toFixed(1)}s left`);
        return;
      }

      const guestPosMs = (player.currentTime ?? 0) * 1000;
      const driftMs = computeOrbitDriftMs(state, guestPosMs, now);

      const plan = planOrbitDriftCorrection({
        driftMs,
        trackDurationMs,
        hostPositionMs,
        hostIsPlaying: state.isPlaying,
        currentRate,
      });

      if (plan.action === 'seek') {
        // Unrecoverable within the track even at the cap — hard-seek to the
        // host's live position (same destination as manual Catch-Up) and drop
        // the soft correction.
        const fraction = Math.max(0, Math.min(0.99, (hostPositionMs / 1000) / Math.max(1, durationSec)));
        note('seek', `drift ${Math.round(driftMs)}ms uncorrectable, seeking`);
        player.seek(fraction);
        resetRate('post-seek'); // re-syncs to host → correction state back to idle
        return;
      }

      const target = plan.action === 'soft' ? plan.targetRate : 1.0;
      currentRate = stepRateToward(currentRate, target);
      applyOrbitDriftRate(currentRate);
      if (plan.action === 'soft') {
        setOrbitDriftStatus({ action: 'soft', currentRate, targetRate: target, expectedDurationSec: plan.expectedDurationSec });
        note('soft', `drift ${Math.round(driftMs)}ms → rate ${target.toFixed(2)}× (~${Math.round(plan.expectedDurationSec)}s)`);
      } else {
        setOrbitDriftStatus({ action: 'hold', currentRate, targetRate: 1.0, expectedDurationSec: null });
        if (currentRate === 1.0) note('hold', `drift ${Math.round(driftMs)}ms within band`);
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
