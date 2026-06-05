//! Server cluster identity — derived `cluster_key` / `album_key` / `artist_key`
//! in a separate attached SQLite DB (`library-cluster.db`). Distinct from
//! `repos/play_session/cluster.rs` (listening-session time-gap grouping).

mod detail;
mod advanced_search;
mod db;
mod keys;
mod library_scope;
mod list;
mod list_albums;
mod list_artists;
mod list_favorites;
mod merge;
mod norm;
mod play_stats;
mod priority;
mod rebuild;
mod resolve;
mod search;

pub use detail::{cluster_album_detail, cluster_artist_detail};
pub use advanced_search::run_cluster_advanced_search;
pub use db::{
    attach_cluster_database, attach_cluster_database_uri, cluster_db_path, ensure_cluster_schema,
    init_cluster_meta, needs_norm_rebuild, ATTACH_ALIAS, CLUSTER_DB_FILENAME, NORM_VERSION,
};
pub use keys::{compute_track_cluster_keys, TrackClusterKeys};
pub use list::list_merged_tracks;
pub use list_albums::list_merged_albums;
pub use list_artists::list_merged_artists;
pub use list_favorites::list_merged_favorite_tracks;
pub use list_favorites::{list_merged_favorite_albums, list_merged_favorite_artists};
pub use merge::DURATION_TOLERANCE_SEC;
pub use play_stats::{
    cluster_day_detail, cluster_heatmap, cluster_most_played, cluster_recent_days, cluster_year_summary,
};
pub use rebuild::{
    rebuild_all_cluster_keys, rebuild_cluster_keys_for_server, rebuild_if_norm_version_stale,
};
pub use resolve::{
    cluster_key_for_track, resolve_candidates_by_cluster_key, resolve_candidates_for_track,
};
pub use search::{run_cluster_random_tracks, run_cluster_search};
