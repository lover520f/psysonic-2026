/**
 * Orbit drift correction — live status snapshot for diagnostics.
 *
 * The guest drift loop publishes what it is doing here; the diagnostics popover
 * reads it on its own 1 s tick. A plain module-level snapshot (not Zustand) so
 * the 500 ms loop never triggers a React re-render cascade — the reader pulls
 * the current value when it repaints.
 */

export type DriftCorrectionAction = 'idle' | 'hold' | 'soft' | 'seek' | 'blend';

export interface OrbitDriftStatus {
  action: DriftCorrectionAction;
  /** Rate currently sent to the engine (1.0 when not correcting). */
  currentRate: number;
  /** Rate the loop is ramping toward (equals currentRate once settled). */
  targetRate: number;
  /** Planner's estimated time to close the gap, or null when not soft-correcting. */
  expectedDurationSec: number | null;
}

const IDLE: OrbitDriftStatus = {
  action: 'idle',
  currentRate: 1.0,
  targetRate: 1.0,
  expectedDurationSec: null,
};

let status: OrbitDriftStatus = IDLE;

export function setOrbitDriftStatus(next: OrbitDriftStatus): void {
  status = next;
}

export function getOrbitDriftStatus(): OrbitDriftStatus {
  return status;
}

export function resetOrbitDriftStatus(): void {
  status = IDLE;
}
