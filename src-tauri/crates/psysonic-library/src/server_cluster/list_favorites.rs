//! Merged favorites — starred on any member counts (spec §4 Tier 2).

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::dto::{
    LibraryAlbumDto, LibraryArtistDto, LibraryClusterAlbumsResponse, LibraryClusterArtistsResponse, LibraryTrackDto,
    LibraryTracksEnvelope,
};
use crate::repos;
use crate::search::{aliased_track_columns, PAGE_LIMIT_MAX};
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;
use super::merge::DURATION_TOLERANCE_SEC;
use super::priority::{in_list_sql, priority_case_sql};

/// Merged starred tracks — one row per merge group when **any** member is starred.
pub fn list_merged_favorite_tracks(
    store: &LibraryStore,
    servers_ordered: &[String],
    limit: u32,
    offset: u32,
) -> Result<LibraryTracksEnvelope, String> {
    if servers_ordered.is_empty() {
        return Ok(LibraryTracksEnvelope {
            tracks: vec![],
            total: 0,
        });
    }
    let limit = limit.clamp(1, PAGE_LIMIT_MAX);
    let offset = offset.min(i32::MAX as u32) as i32;
    let (in_placeholders, mut in_params) = in_list_sql(servers_ordered);
    let (priority_sql, mut priority_params) = priority_case_sql("t.server_id", servers_ordered);

    let cols = aliased_track_columns("t");
    let sql = format!(
        "WITH candidates AS (
           SELECT
             t.rowid AS tid,
             t.server_id,
             t.id AS track_id,
             k.cluster_key,
             COALESCE(k.duration_sec, t.duration_sec) AS dur,
             t.starred_at,
             ({priority_sql}) AS priority_rank
           FROM track t
           LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           WHERE t.deleted = 0 AND t.server_id IN ({in_placeholders})
         ),
         refs AS (
           SELECT cluster_key, MIN(priority_rank) AS best_rank
             FROM candidates
            WHERE cluster_key IS NOT NULL
            GROUP BY cluster_key
         ),
         ref_dur AS (
           SELECT c.cluster_key, c.dur AS ref_dur
             FROM candidates c
             JOIN refs r ON c.cluster_key = r.cluster_key AND c.priority_rank = r.best_rank
         ),
         partitioned AS (
           SELECT c.tid,
             CASE
               WHEN c.cluster_key IS NULL THEN 'solo:' || c.server_id || ':' || c.track_id
               WHEN ABS(c.dur - rd.ref_dur) <= {tol} THEN c.cluster_key
               ELSE 'solo:' || c.server_id || ':' || c.track_id
             END AS merge_key,
             c.priority_rank
           FROM candidates c
           LEFT JOIN ref_dur rd ON c.cluster_key = rd.cluster_key
         ),
         starred_merge AS (
           SELECT DISTINCT p.merge_key
             FROM partitioned p
             JOIN candidates c ON c.tid = p.tid
            WHERE c.starred_at IS NOT NULL
         ),
         winners AS (
           SELECT p.tid, p.merge_key,
             ROW_NUMBER() OVER (PARTITION BY p.merge_key ORDER BY p.priority_rank) AS rn
           FROM partitioned p
           JOIN starred_merge s ON s.merge_key = p.merge_key
         )
         SELECT {cols}
           FROM winners w
           JOIN track t ON t.rowid = w.tid
          WHERE w.rn = 1
          ORDER BY t.title COLLATE NOCASE, t.server_id, t.id
          LIMIT ? OFFSET ?",
        tol = DURATION_TOLERANCE_SEC,
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.append(&mut priority_params);
    params.append(&mut in_params);
    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let tracks: Vec<LibraryTrackDto> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?;

    Ok(LibraryTracksEnvelope {
        total: tracks.len() as u32,
        tracks,
    })
}

/// Merged favorite albums — one row per album merge group when any member is starred.
pub fn list_merged_favorite_albums(
    store: &LibraryStore,
    servers_ordered: &[String],
    limit: u32,
    offset: u32,
) -> Result<LibraryClusterAlbumsResponse, String> {
    if servers_ordered.is_empty() {
        return Ok(LibraryClusterAlbumsResponse {
            albums: vec![],
            has_more: false,
        });
    }
    let limit = limit.clamp(1, PAGE_LIMIT_MAX);
    let offset = offset.min(i32::MAX as u32) as i32;
    let (in_placeholders, mut in_params) = in_list_sql(servers_ordered);
    let (priority_sql, mut priority_params) = priority_case_sql("t.server_id", servers_ordered);

    let sql = format!(
        "WITH candidates AS (
           SELECT
             t.rowid AS tid,
             t.server_id,
             t.album_id,
             k.album_key,
             COALESCE(a.starred_at, t.starred_at) AS starred_at,
             ({priority_sql}) AS priority_rank
           FROM track t
           LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           LEFT JOIN album a
             ON a.server_id = t.server_id AND a.id = t.album_id
           WHERE t.deleted = 0
             AND t.server_id IN ({in_placeholders})
             AND t.album_id IS NOT NULL AND t.album_id != ''
         ),
         partitioned AS (
           SELECT c.tid,
             CASE
               WHEN c.album_key IS NULL THEN 'solo:' || c.server_id || ':' || c.album_id
               ELSE c.album_key
             END AS merge_key,
             c.priority_rank,
             c.starred_at
           FROM candidates c
         ),
         starred_merge AS (
           SELECT DISTINCT merge_key
             FROM partitioned
            WHERE starred_at IS NOT NULL
         ),
         winners AS (
           SELECT p.tid,
             ROW_NUMBER() OVER (PARTITION BY p.merge_key ORDER BY p.priority_rank) AS rn
           FROM partitioned p
           JOIN starred_merge s ON s.merge_key = p.merge_key
         )
         SELECT
           t.server_id,
           t.album_id,
           COALESCE(a.name, t.album),
           COALESCE(a.artist, t.artist),
           COALESCE(a.artist_id, t.artist_id),
           COALESCE(a.song_count, (
             SELECT COUNT(*) FROM track c
              WHERE c.server_id = t.server_id AND c.album_id = t.album_id AND c.deleted = 0
           )),
           COALESCE(a.duration_sec, (
             SELECT COALESCE(SUM(c.duration_sec), 0) FROM track c
              WHERE c.server_id = t.server_id AND c.album_id = t.album_id AND c.deleted = 0
           )),
           COALESCE(a.year, t.year),
           COALESCE(a.genre, t.genre),
           COALESCE(a.cover_art_id, t.cover_art_id),
           COALESCE(a.starred_at, t.starred_at),
           COALESCE(a.synced_at, t.synced_at),
           a.raw_json
         FROM winners w
         JOIN track t ON t.rowid = w.tid
         LEFT JOIN album a ON a.server_id = t.server_id AND a.id = t.album_id
        WHERE w.rn = 1
        ORDER BY COALESCE(a.name, t.album) COLLATE NOCASE, t.server_id, t.album_id
        LIMIT ? OFFSET ?",
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.append(&mut priority_params);
    params.append(&mut in_params);
    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let albums: Vec<LibraryAlbumDto> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), map_album_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?;
    Ok(LibraryClusterAlbumsResponse {
        has_more: albums.len() as u32 == limit,
        albums,
    })
}

/// Merged favorite artists — one row per artist merge group when any member track is starred.
pub fn list_merged_favorite_artists(
    store: &LibraryStore,
    servers_ordered: &[String],
    limit: u32,
    offset: u32,
) -> Result<LibraryClusterArtistsResponse, String> {
    if servers_ordered.is_empty() {
        return Ok(LibraryClusterArtistsResponse {
            artists: vec![],
            has_more: false,
        });
    }
    let limit = limit.clamp(1, PAGE_LIMIT_MAX);
    let offset = offset.min(i32::MAX as u32) as i32;
    let (in_placeholders, mut in_params) = in_list_sql(servers_ordered);
    let (priority_sql, mut priority_params) = priority_case_sql("t.server_id", servers_ordered);

    let sql = format!(
        "WITH candidates AS (
           SELECT
             t.rowid AS tid,
             t.server_id,
             COALESCE(NULLIF(t.artist_id, ''), t.artist) AS artist_ref,
             k.artist_key,
             t.starred_at,
             ({priority_sql}) AS priority_rank
           FROM track t
           LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           WHERE t.deleted = 0
             AND t.server_id IN ({in_placeholders})
             AND COALESCE(t.artist, '') != ''
         ),
         partitioned AS (
           SELECT c.tid,
             CASE
               WHEN c.artist_key IS NULL THEN 'solo:' || c.server_id || ':' || c.artist_ref
               ELSE c.artist_key
             END AS merge_key,
             c.priority_rank,
             c.starred_at
           FROM candidates c
         ),
         starred_merge AS (
           SELECT DISTINCT merge_key
             FROM partitioned
            WHERE starred_at IS NOT NULL
         ),
         winners AS (
           SELECT p.tid,
             ROW_NUMBER() OVER (PARTITION BY p.merge_key ORDER BY p.priority_rank) AS rn
           FROM partitioned p
           JOIN starred_merge s ON s.merge_key = p.merge_key
         )
         SELECT
           t.server_id,
           COALESCE(NULLIF(t.artist_id, ''), t.artist),
           COALESCE(ar.name, t.artist),
           COALESCE(ar.album_count, (
             SELECT COUNT(DISTINCT c.album_id) FROM track c
              WHERE c.server_id = t.server_id
                AND c.deleted = 0
                AND c.album_id IS NOT NULL
                AND (c.artist_id = t.artist_id OR c.artist = t.artist)
           )),
           COALESCE(ar.synced_at, t.synced_at),
           ar.raw_json
         FROM winners w
         JOIN track t ON t.rowid = w.tid
         LEFT JOIN artist ar ON ar.server_id = t.server_id
           AND ar.id = COALESCE(NULLIF(t.artist_id, ''), t.artist)
        WHERE w.rn = 1
        ORDER BY COALESCE(ar.name, t.artist) COLLATE NOCASE, t.server_id
        LIMIT ? OFFSET ?",
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.append(&mut priority_params);
    params.append(&mut in_params);
    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let artists: Vec<LibraryArtistDto> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), map_artist_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?;
    Ok(LibraryClusterArtistsResponse {
        has_more: artists.len() as u32 == limit,
        artists,
    })
}

fn map_album_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
    let raw: Option<String> = r.get(12)?;
    Ok(LibraryAlbumDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        artist: r.get(3)?,
        artist_id: r.get(4)?,
        song_count: r.get(5)?,
        duration_sec: r.get(6)?,
        year: r.get(7)?,
        genre: r.get(8)?,
        cover_art_id: r.get(9)?,
        starred_at: r.get(10)?,
        synced_at: r.get(11)?,
        raw_json: raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null),
    })
}

fn map_artist_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtistDto> {
    let raw: Option<String> = r.get(5)?;
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        album_count: r.get(3)?,
        synced_at: r.get(4)?,
        raw_json: raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use crate::server_cluster::rebuild::rebuild_all_cluster_keys;

    fn track(server: &str, id: &str, starred: bool) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: "Song".into(),
            title_sort: None,
            artist: Some("Band".into()),
            artist_id: Some("a1".into()),
            album: "LP".into(),
            album_id: Some("alb1".into()),
            album_artist: Some("Band".into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: if starred { Some(1) } else { None },
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    #[test]
    fn starred_on_lower_priority_still_surfaces_merged_row() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", false), track("s2", "t2", true)])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        let env = list_merged_favorite_tracks(&store, &["s1".into(), "s2".into()], 50, 0).unwrap();
        assert_eq!(env.tracks.len(), 1);
        assert_eq!(env.tracks[0].server_id, "s1");
    }

    #[test]
    fn unstarred_merge_group_excluded() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", false), track("s2", "t2", false)])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();
        let env = list_merged_favorite_tracks(&store, &["s1".into(), "s2".into()], 50, 0).unwrap();
        assert!(env.tracks.is_empty());
    }

    #[test]
    fn favorite_albums_merge_when_any_member_starred() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", false), track("s2", "t2", true)])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();
        let resp = list_merged_favorite_albums(&store, &["s1".into(), "s2".into()], 50, 0).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].server_id, "s1");
    }

    #[test]
    fn favorite_artists_merge_when_any_member_starred() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", false), track("s2", "t2", true)])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();
        let resp =
            list_merged_favorite_artists(&store, &["s1".into(), "s2".into()], 50, 0).unwrap();
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].server_id, "s1");
    }
}
