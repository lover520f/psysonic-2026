//! Remove browse-index rows orphaned by server-side renames/removals.
//!
//! `getArtists` derives artist ids from tags, so renaming an artist (or an
//! album) mints a *new* id server-side and drops the old one. Track ingest
//! moves the affected tracks onto the new id (or the resync orphan sweep /
//! tombstone reconciler soft-deletes them), but the stale **`artist`** and
//! **`album`** browse rows were never pruned — they lingered in the catalog and
//! opened to "Artist not found" because detail resolves from live tracks.
//!
//! These prunes run on every sync that refreshes the artist index (full and
//! delta), right after the track sweep, and once at open for pre-existing DBs
//! (see `store::maybe_reconcile_orphan_browse_rows`). All three share the same
//! conn-level statements below.
//!
//! Safety — a row is removed only when it is genuinely unreachable:
//! - **Artist:** not confirmed by the latest `getArtists` pass (its
//!   `synced_at` is older than the freshest artist row for the same server)
//!   **and** no live (`deleted = 0`) track credits it. Artists still backing a
//!   live track (any library scope, album credit) or refreshed this pass are
//!   kept, so nothing browsable/openable is dropped.
//! - **Album:** no live track references it **and** it is not starred, so a
//!   favourited album is never dropped even if it briefly loses every track.

use rusqlite::{Connection, Result as SqlResult};

use crate::store::LibraryStore;

/// Rows removed by a single [`prune_library_orphans_for_server`] call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OrphanPruneReport {
    pub artists: u32,
    pub albums: u32,
}

/// Prune orphaned `artist` + `album` rows for one server (sync paths).
pub fn prune_library_orphans_for_server(
    store: &LibraryStore,
    server_id: &str,
) -> Result<OrphanPruneReport, String> {
    store.with_conn_mut("orphan_cleanup.prune_server", |conn| {
        let artists = prune_orphan_artists(conn, Some(server_id))?;
        let albums = prune_orphan_albums(conn, Some(server_id))?;
        Ok(OrphanPruneReport {
            artists: artists as u32,
            albums: albums as u32,
        })
    })
}

/// Delete `artist` rows the latest server pass did not confirm that also have
/// no live track crediting them. Pass `Some(server_id)` to scope to one server
/// (sync paths) or `None` to sweep every server (one-time open reconcile).
pub fn prune_orphan_artists(conn: &Connection, server_id: Option<&str>) -> SqlResult<usize> {
    // The freshest `synced_at` per server marks the most recent successful
    // `getArtists` pass — every artist confirmed then shares it, so rows left
    // below it were dropped by the server. Correlated on `artist.server_id` so
    // the same statement works scoped or global.
    let base = "DELETE FROM artist \
         WHERE synced_at < ( \
             SELECT MAX(ai.synced_at) FROM artist ai WHERE ai.server_id = artist.server_id \
         ) \
         AND NOT EXISTS ( \
             SELECT 1 FROM track \
             WHERE track.server_id = artist.server_id \
               AND track.artist_id = artist.id \
               AND track.deleted = 0 \
         )";
    match server_id {
        Some(sid) => {
            let sql = format!("{base} AND server_id = ?1");
            conn.execute(&sql, rusqlite::params![sid])
        }
        None => conn.execute(base, []),
    }
}

/// Delete `album` rows with no live track and no favourite (`starred_at`).
/// Pass `Some(server_id)` to scope to one server or `None` to sweep all.
pub fn prune_orphan_albums(conn: &Connection, server_id: Option<&str>) -> SqlResult<usize> {
    let base = "DELETE FROM album \
         WHERE starred_at IS NULL \
         AND NOT EXISTS ( \
             SELECT 1 FROM track \
             WHERE track.server_id = album.server_id \
               AND track.album_id = album.id \
               AND track.deleted = 0 \
         )";
    match server_id {
        Some(sid) => {
            let sql = format!("{base} AND server_id = ?1");
            conn.execute(&sql, rusqlite::params![sid])
        }
        None => conn.execute(base, []),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_artist(store: &LibraryStore, server: &str, id: &str, synced_at: i64) {
        store
            .with_conn_mut("test.seed_artist", |c| {
                c.execute(
                    "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                     VALUES (?1, ?2, ?2, ?2, ?3)",
                    rusqlite::params![server, id, synced_at],
                )
            })
            .unwrap();
    }

    fn seed_track(
        store: &LibraryStore,
        server: &str,
        id: &str,
        artist_id: &str,
        album_id: &str,
        deleted: bool,
    ) {
        store
            .with_conn_mut("test.seed_track", |c| {
                c.execute(
                    "INSERT INTO track (server_id, id, title, artist_id, album, album_id, \
                       duration_sec, deleted, synced_at, raw_json) \
                     VALUES (?1, ?2, 'Song', ?3, 'Al', ?4, 1, ?5, 1, '{}')",
                    rusqlite::params![server, id, artist_id, album_id, i64::from(deleted)],
                )
            })
            .unwrap();
    }

    fn seed_album(store: &LibraryStore, server: &str, id: &str, starred_at: Option<i64>) {
        store
            .with_conn_mut("test.seed_album", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES (?1, ?2, ?2, ?3, 1, '{}')",
                    rusqlite::params![server, id, starred_at],
                )
            })
            .unwrap();
    }

    fn artist_ids(store: &LibraryStore, server: &str) -> Vec<String> {
        store
            .with_read_conn(|c| {
                let mut stmt = c
                    .prepare("SELECT id FROM artist WHERE server_id = ?1 ORDER BY id")?;
                let rows = stmt
                    .query_map(rusqlite::params![server], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap()
    }

    fn album_ids(store: &LibraryStore, server: &str) -> Vec<String> {
        store
            .with_read_conn(|c| {
                let mut stmt =
                    c.prepare("SELECT id FROM album WHERE server_id = ?1 ORDER BY id")?;
                let rows = stmt
                    .query_map(rusqlite::params![server], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap()
    }

    #[test]
    fn prunes_renamed_away_artist_but_keeps_live_and_confirmed() {
        let store = LibraryStore::open_in_memory();
        // ar_new: confirmed this pass (fresh synced_at) + live track → keep.
        seed_artist(&store, "s1", "ar_new", 100);
        seed_track(&store, "s1", "tr_1", "ar_new", "al_1", false);
        // ar_old: stale synced_at, only a soft-deleted track (renamed away) → prune.
        seed_artist(&store, "s1", "ar_old", 50);
        seed_track(&store, "s1", "tr_1_old", "ar_old", "al_1", true);
        // ar_scopeb: stale synced_at but still backs a live track (other scope) → keep.
        seed_artist(&store, "s1", "ar_scopeb", 50);
        seed_track(&store, "s1", "tr_2", "ar_scopeb", "al_2", false);

        let report = prune_library_orphans_for_server(&store, "s1").unwrap();
        assert_eq!(report.artists, 1);
        assert_eq!(artist_ids(&store, "s1"), vec!["ar_new", "ar_scopeb"]);
    }

    #[test]
    fn keeps_album_artist_confirmed_this_pass_without_track_credit() {
        let store = LibraryStore::open_in_memory();
        // Various-Artists style row: no track credits its id, but it was just
        // confirmed by getArtists (shares the freshest synced_at) → keep.
        seed_artist(&store, "s1", "ar_va", 100);
        seed_artist(&store, "s1", "ar_real", 100);
        seed_track(&store, "s1", "tr_1", "ar_real", "al_1", false);

        let report = prune_library_orphans_for_server(&store, "s1").unwrap();
        assert_eq!(report.artists, 0);
        assert_eq!(artist_ids(&store, "s1"), vec!["ar_real", "ar_va"]);
    }

    #[test]
    fn prunes_orphan_album_but_keeps_starred_and_live() {
        let store = LibraryStore::open_in_memory();
        seed_album(&store, "s1", "al_live", None);
        seed_track(&store, "s1", "tr_1", "ar_1", "al_live", false);
        seed_album(&store, "s1", "al_orphan", None);
        seed_track(&store, "s1", "tr_2", "ar_1", "al_orphan", true);
        seed_album(&store, "s1", "al_starred", Some(1_700_000_000_000));

        let report = prune_library_orphans_for_server(&store, "s1").unwrap();
        assert_eq!(report.albums, 1);
        assert_eq!(album_ids(&store, "s1"), vec!["al_live", "al_starred"]);
    }

    #[test]
    fn scopes_prune_to_a_single_server() {
        let store = LibraryStore::open_in_memory();
        seed_artist(&store, "s1", "ar_fresh", 100);
        seed_track(&store, "s1", "tr_1", "ar_fresh", "al_1", false);
        seed_artist(&store, "s1", "ar_ghost", 50);
        // Another server with its own ghost — must be untouched by scoped prune.
        seed_artist(&store, "s2", "ar_fresh2", 100);
        seed_track(&store, "s2", "tr_2", "ar_fresh2", "al_2", false);
        seed_artist(&store, "s2", "ar_ghost2", 50);

        let report = prune_library_orphans_for_server(&store, "s1").unwrap();
        assert_eq!(report.artists, 1);
        assert_eq!(artist_ids(&store, "s1"), vec!["ar_fresh"]);
        assert_eq!(artist_ids(&store, "s2"), vec!["ar_fresh2", "ar_ghost2"]);
    }

    #[test]
    fn global_prune_sweeps_every_server() {
        let store = LibraryStore::open_in_memory();
        seed_artist(&store, "s1", "ar_fresh", 100);
        seed_track(&store, "s1", "tr_1", "ar_fresh", "al_1", false);
        seed_artist(&store, "s1", "ar_ghost", 50);
        seed_artist(&store, "s2", "ar_fresh2", 100);
        seed_track(&store, "s2", "tr_2", "ar_fresh2", "al_2", false);
        seed_artist(&store, "s2", "ar_ghost2", 50);

        let removed = store
            .with_conn_mut("test.global", |c| prune_orphan_artists(c, None))
            .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(artist_ids(&store, "s1"), vec!["ar_fresh"]);
        assert_eq!(artist_ids(&store, "s2"), vec!["ar_fresh2"]);
    }
}
