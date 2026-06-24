import { useAuthStore } from '../../store/authStore';
import {
  edgeDurationOptionsFromSettings,
  planEdgeMixForSkip,
  type EdgeMixPlan,
} from '../waveform/autodjEdgeMix';
import { getTransitionMode } from './playbackTransition';

/**
 * True when switching to a different track while audio is already playing should
 * use the AutoDJ interrupt blend (same rules as manual skip). Excludes JS
 * auto-advance handoffs — those consume `armCrossfadeDynamicOverlap` instead.
 */
export function shouldAutodjInterruptBlend(
  wasPlaying: boolean,
  hasJsAutoHandoff = false,
): boolean {
  if (!wasPlaying || hasJsAutoHandoff) return false;
  const auth = useAuthStore.getState();
  return getTransitionMode(auth) === 'autodj'
    && auth.autodjSmoothSkip
    && !auth.gaplessEnabled;
}

/** @deprecated Use {@link shouldAutodjInterruptBlend} — manual flag is no longer required. */
export function shouldAutodjManualBlend(manual: boolean, wasPlaying: boolean): boolean {
  void manual;
  return shouldAutodjInterruptBlend(wasPlaying);
}

/**
 * AutoDJ manual skip / interrupt blend plan (§10.6). Delegates to the edge-mix
 * planner with the mid-track skip position on A, so the same content-derived
 * linear blend used for end-of-track transitions applies from the current
 * position. Honours the user's AutoDJ min/max transition bounds (0 = Auto).
 *
 * Returns null when either waveform is missing or A has too little audible tail
 * left for a stable blend — the caller then falls back to a plain cut.
 */
export function computeAutodjManualBlendPlan(
  aBins: number[] | null | undefined,
  aDurationSec: number,
  skipFromTimeSec: number,
  bBins: number[] | null | undefined,
  bDurationSec: number,
): EdgeMixPlan | null {
  const aDur = Number.isFinite(aDurationSec) && aDurationSec > 0 ? aDurationSec : 0;
  const bDur = Number.isFinite(bDurationSec) && bDurationSec > 0 ? bDurationSec : 0;
  if (aDur <= 0 || bDur <= 0) return null;

  const { autodjMinTransitionSec, autodjMaxTransitionSec } = useAuthStore.getState();
  const opts = edgeDurationOptionsFromSettings(autodjMinTransitionSec, autodjMaxTransitionSec);
  return planEdgeMixForSkip(aBins, aDur, skipFromTimeSec, bBins, bDur, opts);
}
