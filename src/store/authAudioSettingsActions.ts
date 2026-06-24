import { clampStoredLoudnessPreAnalysisAttenuationRefDb } from '../utils/audio/loudnessPreAnalysisSlider';
import {
  AUTODJ_MAX_TRANSITION_SEC_MAX,
  AUTODJ_MAX_TRANSITION_SEC_MIN,
  AUTODJ_MIN_TRANSITION_SEC_MAX,
  AUTODJ_MIN_TRANSITION_SEC_MIN,
  DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB,
} from './authStoreDefaults';
import { clampAutodjTransitionSec } from './authStoreHelpers';
import { usePlayerStore } from './playerStore';
import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Audio/playback settings. ReplayGain/normalization/loudness mode
 * toggles call `usePlayerStore.getState().updateReplayGainForCurrentTrack()`
 * so a running track's engine state catches up to the new mode without
 * waiting for the next play. The plain crossfade/gapless/hi-res/output
 * setters skip that — they don't change the gain state, only the
 * neighbouring transitions or device routing.
 */
export function createAudioSettingsActions(set: SetState): Pick<
  AuthState,
  | 'setReplayGainEnabled'
  | 'setNormalizationEngine'
  | 'setLoudnessTargetLufs'
  | 'setLoudnessPreAnalysisAttenuationDb'
  | 'resetLoudnessPreAnalysisAttenuationDbDefault'
  | 'setReplayGainMode'
  | 'setReplayGainPreGainDb'
  | 'setReplayGainFallbackDb'
  | 'setCrossfadeEnabled'
  | 'setCrossfadeSecs'
  | 'setCrossfadeTrimSilence'
  | 'setAutodjSmoothSkip'
  | 'setAutodjMinTransitionSec'
  | 'setAutodjMaxTransitionSec'
  | 'setGaplessEnabled'
  | 'setEnableHiRes'
  | 'setAudioOutputDevice'
> {
  return {
    setReplayGainEnabled: (v) => {
      set({ replayGainEnabled: v });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    },
    setNormalizationEngine: (v) => {
      set({ normalizationEngine: v });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    },
    setLoudnessTargetLufs: (v) => {
      set({ loudnessTargetLufs: v });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    },
    setLoudnessPreAnalysisAttenuationDb: (v) => {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return;
      set({ loudnessPreAnalysisAttenuationDb: clampStoredLoudnessPreAnalysisAttenuationRefDb(n) });
    },
    resetLoudnessPreAnalysisAttenuationDbDefault: () => {
      set({ loudnessPreAnalysisAttenuationDb: DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    },
    setReplayGainMode: (v) => {
      set({ replayGainMode: v });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    },
    setReplayGainPreGainDb: (v) => {
      set({ replayGainPreGainDb: v });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    },
    setReplayGainFallbackDb: (v) => {
      set({ replayGainFallbackDb: v });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    },
    setCrossfadeEnabled: (v) => set({ crossfadeEnabled: v }),
    setCrossfadeSecs: (v) => set({ crossfadeSecs: v }),
    setCrossfadeTrimSilence: (v) => set({ crossfadeTrimSilence: v }),
    setAutodjSmoothSkip: (v) => set({ autodjSmoothSkip: v }),
    setAutodjMinTransitionSec: (v) => set({
      autodjMinTransitionSec: clampAutodjTransitionSec(
        v, AUTODJ_MIN_TRANSITION_SEC_MIN, AUTODJ_MIN_TRANSITION_SEC_MAX,
      ),
    }),
    setAutodjMaxTransitionSec: (v) => set({
      autodjMaxTransitionSec: clampAutodjTransitionSec(
        v, AUTODJ_MAX_TRANSITION_SEC_MIN, AUTODJ_MAX_TRANSITION_SEC_MAX,
      ),
    }),
    setGaplessEnabled: (v) => set({ gaplessEnabled: v }),
    setEnableHiRes: (v) => set({ enableHiRes: v }),
    setAudioOutputDevice: (v) => set({ audioOutputDevice: v }),
  };
}
