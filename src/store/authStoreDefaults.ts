import type {
  LoudnessLufsPreset,
  LyricsSourceConfig,
  TrackPreviewLocation,
  TrackPreviewLocations,
} from './authStoreTypes';

export const LOUDNESS_LUFS_PRESETS: LoudnessLufsPreset[] = [-16, -14, -12, -10];

/** Settings default + Rust engine cold default until `audio_set_normalization` runs. */
export const DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB = -4.5;

export const TRACK_PREVIEW_LOCATIONS: readonly TrackPreviewLocation[] = [
  'suggestions',
  'albums',
  'playlists',
  'favorites',
  'artist',
  'randomMix',
];

export const DEFAULT_TRACK_PREVIEW_LOCATIONS: TrackPreviewLocations = {
  suggestions: true,
  albums: true,
  playlists: true,
  favorites: true,
  artist: true,
  randomMix: true,
};

// Fresh installs ship with every lyrics source off (issue #810 — users who
// don't want lyrics get none until they opt in). Existing users keep their
// persisted `lyricsSources`; the rehydrate migration preserves them.
export const DEFAULT_LYRICS_SOURCES: LyricsSourceConfig[] = [
  { id: 'server',  enabled: false },
  { id: 'lrclib',  enabled: false },
  { id: 'netease', enabled: false },
];

/** Upper bound for mix min-rating thresholds (UI shows five stars, only 1…this many are selectable). */
export const MIX_MIN_RATING_FILTER_MAX_STARS = 3;

export const RANDOM_MIX_SIZE_OPTIONS: readonly number[] = [50, 75, 100, 125, 150];

/** Default max columns for album/artist/playlist card grids (Settings → Library). */
export const DEFAULT_LIBRARY_GRID_MAX_COLUMNS = 6;
export const LIBRARY_GRID_MAX_COLUMNS_MIN = 4;
export const LIBRARY_GRID_MAX_COLUMNS_MAX = 12;

// AutoDJ transition-length user bounds (Settings → Track transitions). `0` is the
// "Auto" sentinel — the edge-mix algorithm uses its own content-derived span with
// no user floor/ceiling. A non-zero value clamps `transition_dur` (and the edge
// analysis window) to that many seconds. Min must stay ≤ max at use sites.
export const AUTODJ_MIN_TRANSITION_SEC_MIN = 0.5;
export const AUTODJ_MIN_TRANSITION_SEC_MAX = 10;
export const AUTODJ_MAX_TRANSITION_SEC_MIN = 1;
// Upper ceiling mirrors the engine's AutoDJ mix clamp in `audio_play`
// (`mix_secs.clamp(0.5, 12.0)`) — keep them in lockstep so a configured max is
// actually honoured end-to-end (no silent re-clamp in Rust).
export const AUTODJ_MAX_TRANSITION_SEC_MAX = 12;
