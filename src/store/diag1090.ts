// [DIAG #1090/#1072 — TEMPORARY] Freeze-survivable marker trail.
//
// The UI hang blocks the JS main thread, so async `invoke()` logging loses the
// final marker before the freeze (the IPC flush never runs). We therefore also
// write each marker SYNCHRONOUSLY to localStorage, which persists across the
// freeze and the process kill. On the next launch `recoverDiag1090()` reads the
// trail back and forwards it to the Rust log, revealing the last reached point
// right before the hang. Remove this file with the real fix.
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from './authStore';

const KEY = 'diag1090_trail';

export function markDiag1090(m: string): void {
  // Synchronous, freeze-proof: even if the thread blocks on the next line, this
  // value is already committed to disk.
  try {
    const prev = localStorage.getItem(KEY);
    const next = (prev ? prev + '\n' : '') + `${Date.now()}: ${m}`;
    localStorage.setItem(KEY, next.split('\n').slice(-30).join('\n'));
  } catch {
    // ignore — diagnostics must never throw
  }
  // Best-effort live log (only survives when no freeze follows).
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  void invoke('frontend_debug_log', { scope: 'diag1090', message: m }).catch(() => {});
}

// Call once on app start: if the previous session left a trail (it froze), emit
// it to the Rust log, then clear it.
export function recoverDiag1090(): void {
  try {
    const trail = localStorage.getItem(KEY);
    if (!trail) return;
    localStorage.removeItem(KEY);
    void invoke('frontend_debug_log', {
      scope: 'diag1090',
      message: `RECOVERED TRAIL from previous session (last line = point before freeze):\n${trail}`,
    }).catch(() => {});
  } catch {
    // ignore
  }
}
