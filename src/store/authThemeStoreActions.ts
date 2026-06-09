import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/** Theme Store opt-in (catalogue browse + global install/rating stats). */
export function createThemeStoreActions(set: SetState): Pick<AuthState, 'setThemeStoreStatsEnabled'> {
  return {
    setThemeStoreStatsEnabled: (v) => set({ themeStoreStatsEnabled: v }),
  };
}
