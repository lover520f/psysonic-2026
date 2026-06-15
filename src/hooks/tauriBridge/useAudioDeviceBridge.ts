import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';
import { setSeekFallbackVisualTarget } from '../../store/seekFallbackState';
// [DIAG #1090/#1072 — TEMPORARY] freeze-survivable markers (see diag1090.ts).
import { markDiag1090 as diag1090, recoverDiag1090 } from '../../store/diag1090';

/** Audio output device lifecycle: device switches (Bluetooth headphones, USB
 * DAC, …) and pinned-device-unplugged fallbacks emitted by the Rust
 * device-watcher.
 *
 * Rust emits two different payload shapes:
 *   null   → Rust replayed the track internally; no frontend restart needed.
 *   number → Rust could not replay (radio, uncached HTTP, paused); frontend
 *            must call playTrack and seek to that position.
 */
export function useAudioDeviceBridge() {
  // [DIAG #1090/#1072 — TEMPORARY] On mount, surface any marker trail the
  // previous (frozen, then killed) session left behind.
  useEffect(() => { recoverDiag1090(); }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-changed', (event) => {
      diag1090(`device-changed received payload=${JSON.stringify(event.payload)}`);
      // null payload = Rust handled internal replay; nothing to do here.
      if (event.payload === null) return;

      const resumeAt = typeof event.payload === 'number' ? event.payload : 0;
      const { currentTrack, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      diag1090(`state currentTrack=${!!currentTrack} isPlaying=${isPlaying} resumeAt=${resumeAt}`);
      if (!currentTrack) return;
      if (isPlaying) {
        if (resumeAt > 0.5 && currentTrack.duration > 0) {
          setSeekFallbackVisualTarget({
            trackId: currentTrack.id,
            seconds: resumeAt,
            setAtMs: Date.now(),
          });
        }
        diag1090('before playTrack');
        playTrack(currentTrack);
        diag1090('after playTrack (returned)');
      } else {
        // Paused: clear warm-pause flag so the next resume uses the cold path
        // (audio_play + seek) which creates a new Sink on the new device.
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Pinned output device was unplugged — Rust already fell back to system default.
  // Always clear the stored device so the Settings dropdown resets to "System Default",
  // even when Rust handled internal replay (null payload).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-reset', (event) => {
      useAuthStore.getState().setAudioOutputDevice(null);

      // null payload = Rust handled internal replay on the new default device.
      if (event.payload === null) return;

      const resumeAt = typeof event.payload === 'number' ? event.payload : 0;
      const { currentTrack, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      if (!currentTrack) return;
      if (isPlaying) {
        if (resumeAt > 0.5 && currentTrack.duration > 0) {
          setSeekFallbackVisualTarget({
            trackId: currentTrack.id,
            seconds: resumeAt,
            setAtMs: Date.now(),
          });
        }
        playTrack(currentTrack);
      } else {
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Output stream was released after idle — next resume must use the cold path.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:output-released', () => {
      usePlayerStore.getState().resetAudioPause();
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);
}
