import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

/** Theme Store opt-in (catalogue browse + global install/rating stats). */
export function createThemeStoreActions(
  set: SetState,
  get: GetState,
): Pick<AuthState, 'setThemeStoreStatsEnabled' | 'ensureThemeStoreClientKey' | 'setThemeStoreRating'> {
  return {
    setThemeStoreStatsEnabled: (v) => set({ themeStoreStatsEnabled: v }),
    setThemeStoreRating: (themeId, rating) =>
      set((s) => ({ themeStoreMyRatings: { ...s.themeStoreMyRatings, [themeId]: rating } })),
    // Anonymous, persistent client id for install/rating dedupe. Lazily created
    // on first contribution; no PII, never sent until the user opts in + acts.
    ensureThemeStoreClientKey: () => {
      const existing = get().themeStoreClientKey;
      if (existing) return existing;
      const key = crypto.randomUUID();
      set({ themeStoreClientKey: key });
      return key;
    },
  };
}
