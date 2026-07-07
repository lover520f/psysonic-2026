//! Persist Subsonic `getArtists` / `getIndexes` bodies into the local `artist` table.

use crate::repos::{ArtistRepository, SyncStateRepository};
use crate::store::LibraryStore;
use psysonic_integration::subsonic::ArtistIndex;

use super::error::SyncError;

pub fn apply_artist_index(
    store: &LibraryStore,
    server_id: &str,
    library_scope: &str,
    index: &ArtistIndex,
) -> Result<(), SyncError> {
    let synced_at = super::now_unix_ms();
    let ignored = crate::artist_sort::ignored_articles_or_default(
        index.ignored_articles.as_deref(),
    );
    let sync_state = SyncStateRepository::new(store);
    sync_state
        .set_ignored_articles(server_id, library_scope, ignored)
        .map_err(SyncError::Storage)?;
    let repo = ArtistRepository::new(store);
    repo.upsert_index(server_id, index, synced_at).map_err(SyncError::Storage)?;
    repo.backfill_from_tracks(server_id, ignored, synced_at).map_err(SyncError::Storage)?;
    // Drop `artist`/`album` browse rows this pass no longer confirms and that
    // have no live track behind them — otherwise a server-side rename leaves a
    // ghost that opens to "Artist not found" (fixed by matching the fresh
    // `synced_at` stamp just written above).
    let pruned = crate::orphan_cleanup::prune_library_orphans_for_server(store, server_id)
        .map_err(SyncError::Storage)?;
    if pruned.artists > 0 || pruned.albums > 0 {
        crate::app_eprintln!(
            "[library-sync] pruned {} orphan artist(s), {} orphan album(s)",
            pruned.artists,
            pruned.albums
        );
    }
    if let Some(ms) = index.last_modified_ms {
        sync_state
            .set_artists_last_modified_ms(server_id, library_scope, ms)
            .map_err(SyncError::Storage)?;
    }
    Ok(())
}
