import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import { useAuthStore } from '../store/authStore';
import { showToast } from '../utils/ui/toast';
import {
  clearOrbitLastSession,
  findSessionPlaylistId,
  joinOrbitSession,
  ORBIT_RECONNECT_COUNTDOWN_S,
  ORBIT_RECONNECT_MAX_AGE_MS,
  readOrbitLastSession,
  readOrbitState,
  resumeOrbitSessionAsHost,
  type OrbitLastSession,
} from '../utils/orbit';

/**
 * Orbit — reconnect prompt shown at startup when the app was restarted while a
 * session was active. The in-memory Orbit store is gone after a restart, but
 * the `lastSession` breadcrumb survives; this verifies the session is still
 * alive on the server and offers a one-click rejoin with a countdown that
 * auto-rejoins when it reaches zero.
 *
 * Host breadcrumbs resume hosting (`resumeOrbitSessionAsHost`); guest
 * breadcrumbs rejoin via the normal `joinOrbitSession` path. Declining /
 * Escape / a failed attempt wipes the breadcrumb so it isn't offered again.
 */
export default function OrbitReconnectModal() {
  const { t } = useTranslation();
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const orbitRole = useOrbitStore(s => s.role);

  const [candidate, setCandidate] = useState<OrbitLastSession | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(ORBIT_RECONNECT_COUNTDOWN_S);
  const [busy, setBusy] = useState(false);
  const ranRef = useRef(false);
  const firedRef = useRef(false);

  // One-shot startup preflight: is there a live session worth offering?
  useEffect(() => {
    if (ranRef.current) return;
    if (!isLoggedIn || !activeServerId) return; // wait for auth hydration
    if (orbitRole !== null) return;             // already bound to a session
    ranRef.current = true;

    const rec = readOrbitLastSession();
    if (!rec || rec.serverId !== activeServerId) return; // none / different server

    let cancelled = false;
    void (async () => {
      try {
        const sessionPlaylistId = await findSessionPlaylistId(rec.sid);
        if (!sessionPlaylistId) { clearOrbitLastSession(); return; }
        const state = await readOrbitState(sessionPlaylistId);
        if (!state || state.ended) { clearOrbitLastSession(); return; }
        // Too long since the last host snapshot → treat as dead, don't offer.
        if (Date.now() - (state.positionAt ?? 0) > ORBIT_RECONNECT_MAX_AGE_MS) {
          clearOrbitLastSession();
          return;
        }
        // A host breadcrumb only resumes if we're still the session's host.
        if (rec.role === 'host' && state.host !== useAuthStore.getState().getActiveServer()?.username) {
          clearOrbitLastSession();
          return;
        }
        if (!cancelled) setCandidate(rec);
      } catch {
        /* network hiccup — keep the breadcrumb, just skip the prompt this launch */
      }
    })();
    return () => { cancelled = true; };
  }, [isLoggedIn, activeServerId, orbitRole]);

  const doReconnect = useCallback(async () => {
    if (firedRef.current) return; // guard countdown + manual click racing
    const rec = candidate;
    if (!rec) return;
    firedRef.current = true;
    setBusy(true);
    try {
      if (rec.role === 'host') await resumeOrbitSessionAsHost(rec.sid);
      else await joinOrbitSession(rec.sid);
      setCandidate(null); // success → store now bound, modal hides
    } catch {
      clearOrbitLastSession();
      showToast(t('orbit.reconnect.failed'), 4000, 'error');
      setCandidate(null);
    } finally {
      setBusy(false);
    }
  }, [candidate, t]);

  const stayOut = useCallback(() => {
    clearOrbitLastSession();
    setCandidate(null);
  }, []);

  // Countdown → auto-rejoin at zero. Paused while a reconnect is in flight.
  useEffect(() => {
    if (!candidate || busy) return;
    if (secondsLeft <= 0) { void doReconnect(); return; }
    const id = window.setTimeout(() => setSecondsLeft(s => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [candidate, busy, secondsLeft, doReconnect]);

  // Enter → rejoin now; Escape → stay out (explicit dismissal, no auto-rejoin).
  useEffect(() => {
    if (!candidate) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); void doReconnect(); }
      else if (e.key === 'Escape') { e.preventDefault(); stayOut(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [candidate, doReconnect, stayOut]);

  if (!candidate) return null;

  const body = candidate.role === 'host'
    ? t('orbit.reconnect.bodyHost', { name: candidate.sessionName })
    : t('orbit.reconnect.bodyGuest', { host: candidate.hostUsername, name: candidate.sessionName });

  return createPortal(
    <div
      className="modal-overlay orbit-exit-overlay"
      onClick={e => { if (e.target === e.currentTarget) stayOut(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="orbit-reconnect-title"
    >
      <div className="modal-content orbit-exit-modal">
        <h3 id="orbit-reconnect-title" className="orbit-exit-modal__title">{t('orbit.reconnect.title')}</h3>
        <p className="orbit-exit-modal__body">{body}</p>
        {!busy && (
          <p className="orbit-reconnect-countdown">{t('orbit.reconnect.autoIn', { seconds: secondsLeft })}</p>
        )}
        <div className="orbit-exit-modal__actions">
          <button type="button" className="btn btn-ghost" onClick={stayOut} disabled={busy}>
            {t('orbit.reconnect.stayOut')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void doReconnect()} disabled={busy} autoFocus>
            {busy ? t('orbit.reconnect.reconnecting') : t('orbit.reconnect.rejoin')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
