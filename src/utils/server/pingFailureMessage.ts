import type { PingFailure } from '../../api/subsonicTypes';

/**
 * Map a ping failure to an i18n key (+ interpolation vars) for the connection
 * error toast, so the user sees a specific reason instead of a generic
 * "Connection failed":
 *   - network/TLS  → actionable "couldn't reach the server" message with detail
 *   - any reachable-but-rejected case (auth, version, other) → the server's own
 *     Subsonic error message, which is already human-readable.
 */
export function pingFailureMessage(failure: PingFailure | undefined): {
  key: string;
  vars?: Record<string, string | number>;
} {
  if (failure?.reason === 'network') {
    return { key: 'settings.serverAddUnreachable', vars: { detail: failure.message ?? '' } };
  }
  if (failure?.message) {
    return { key: 'settings.serverAddRejected', vars: { message: failure.message } };
  }
  return { key: 'settings.serverFailed' };
}
