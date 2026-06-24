import React from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../store/authStore';
import {
  AUTODJ_MAX_TRANSITION_SEC_MAX,
  AUTODJ_MAX_TRANSITION_SEC_MIN,
  AUTODJ_MIN_TRANSITION_SEC_MAX,
  AUTODJ_MIN_TRANSITION_SEC_MIN,
} from '../../../store/authStoreDefaults';
import { useOrbitStore } from '../../../store/orbitStore';
import {
  getTransitionMode,
  setTransitionMode,
  type TransitionMode,
} from '../../../utils/playback/playbackTransition';
import { SettingsGroup } from '../SettingsGroup';
import { SettingsToggle } from '../SettingsToggle';

interface Props {
  t: TFunction;
}

interface BoundRowProps {
  label: string;
  autoLabel: string;
  unit: string;
  /** Stored value; `0` (or less) means Auto. */
  value: number;
  min: number;
  max: number;
  /** Value applied when the user turns Auto off. */
  enabledDefault: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}

/** One AutoDJ transition bound: an Auto checkbox + a seconds input (disabled while Auto). */
function TransitionBoundRow({
  label, autoLabel, unit, value, min, max, enabledDefault, disabled, onChange,
}: BoundRowProps) {
  const isAuto = !(value > 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
      <span style={{ minWidth: 56, fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
        <input
          type="checkbox"
          checked={isAuto}
          disabled={disabled}
          onChange={e => onChange(e.target.checked ? 0 : enabledDefault)}
        />
        {autoLabel}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        step={0.5}
        value={isAuto ? '' : value}
        disabled={isAuto || disabled}
        placeholder="—"
        onChange={e => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        style={{ width: 72 }}
      />
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{unit}</span>
    </div>
  );
}

/**
 * Track-transition picker. Crossfade, AutoDJ and Gapless are mutually
 * exclusive — only one can be active — so they are presented as a single
 * `Off | Gapless | Crossfade | AutoDJ` segmented control backed by the shared
 * transition-mode helper.
 *
 * Classic crossfade exposes the seconds slider; AutoDJ is content-driven and
 * has no duration to configure (just a short explainer + the smooth-skip
 * toggle).
 *
 * Rendered as its own top-level "Track transitions" category in the Audio tab,
 * so the boxed `SettingsGroup` is title-less — the `SettingsSubSection` header
 * names it.
 */
export function TrackTransitionsBlock({ t }: Props) {
  const auth = useAuthStore();
  const mode = getTransitionMode(auth);
  // While a guest in a live Orbit session, transitions mirror the host's and
  // are re-applied every read tick — let the user see them but not fight the
  // sync. Restored to their own on leave.
  const hostControlled = useOrbitStore(
    s => s.role === 'guest' && (s.phase === 'active' || s.phase === 'joining'),
  );

  const transitions: { id: TransitionMode; label: string }[] = [
    { id: 'none', label: t('settings.transitionOff') },
    { id: 'gapless', label: t('settings.gapless') },
    { id: 'crossfade', label: t('settings.crossfade') },
    { id: 'autodj', label: t('settings.autoDj') },
  ];

  return (
    <SettingsGroup>
      {hostControlled && (
        <div style={{ marginBottom: '0.6rem', fontSize: 12, color: 'var(--text-muted)' }}>
          {t('settings.transitionsHostControlled')}
        </div>
      )}
      <div className="settings-segmented" style={hostControlled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
        {transitions.map(item => (
          <button
            key={item.id}
            type="button"
            className={`btn ${mode === item.id ? 'btn-primary' : 'btn-ghost'}`}
            disabled={hostControlled}
            onClick={() => setTransitionMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {mode === 'crossfade' && (
        <div style={{ paddingLeft: '1rem', marginTop: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={auth.crossfadeSecs}
            disabled={hostControlled}
            onChange={e => auth.setCrossfadeSecs(parseFloat(e.target.value))}
            style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
            id="crossfade-secs-slider"
          />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 36 }}>
            {t('settings.crossfadeSecs', { n: auth.crossfadeSecs.toFixed(1) })}
          </span>
        </div>
      )}
      {mode === 'autodj' && (
        <>
          <div style={{ paddingLeft: '1rem', fontSize: 12, color: 'var(--text-muted)', marginTop: '0.7rem' }}>
            {t('settings.autoDjDesc')}
          </div>
          <div style={{ paddingLeft: '1rem', marginTop: '0.7rem' }}>
            <SettingsToggle
              label={t('settings.autodjSmoothSkip')}
              desc={t('settings.autodjSmoothSkipDesc')}
              checked={auth.autodjSmoothSkip}
              disabled={hostControlled}
              onChange={auth.setAutodjSmoothSkip}
            />
          </div>
          <div style={{ paddingLeft: '1rem', marginTop: '0.9rem' }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 2 }}>
              {t('settings.autodjTransitionBounds')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.6rem' }}>
              {t('settings.autodjTransitionBoundsDesc')}
            </div>
            <TransitionBoundRow
              label={t('settings.autodjMinLabel')}
              autoLabel={t('settings.autodjAuto')}
              unit={t('settings.autodjSecondsUnit')}
              value={auth.autodjMinTransitionSec}
              min={AUTODJ_MIN_TRANSITION_SEC_MIN}
              max={AUTODJ_MIN_TRANSITION_SEC_MAX}
              enabledDefault={2}
              disabled={hostControlled}
              onChange={auth.setAutodjMinTransitionSec}
            />
            <TransitionBoundRow
              label={t('settings.autodjMaxLabel')}
              autoLabel={t('settings.autodjAuto')}
              unit={t('settings.autodjSecondsUnit')}
              value={auth.autodjMaxTransitionSec}
              min={AUTODJ_MAX_TRANSITION_SEC_MIN}
              max={AUTODJ_MAX_TRANSITION_SEC_MAX}
              enabledDefault={8}
              disabled={hostControlled}
              onChange={auth.setAutodjMaxTransitionSec}
            />
          </div>
        </>
      )}
    </SettingsGroup>
  );
}
