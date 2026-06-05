//! Merged album listing for cluster scope (spec §4 Tier 1 — dedup by `album_key`).

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::dto::{LibraryAlbumDto, LibraryClusterAlbumsResponse};
use crate::search::PAGE_LIMIT_MAX;
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;
use super::library_scope::scope_filter_sql_and_params;
use super::priority::{in_list_sql, priority_case_sql};

pub fn list_merged_albums(
    store: &LibraryStore,
    servers_ordered: &[String],
    limit: u32,
    offset: u32,
    library_scopes: &std::collections::HashMap<String, Vec<String>>,
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
    let (scope_sql, mut scope_params) = scope_filter_sql_and_params("t", servers_ordered, library_scopes);

    let sql = format!(
        "WITH candidates AS (
           SELECT
             t.rowid AS tid,
             t.server_id,
             t.album_id,
             k.album_key,
             ({priority_sql}) AS priority_rank
           FROM track t
           LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           WHERE t.deleted = 0
             AND t.server_id IN ({in_placeholders})
             AND t.album_id IS NOT NULL AND t.album_id != ''{scope_sql}
         ),
         partitioned AS (
           SELECT c.tid,
             CASE
               WHEN c.album_key IS NULL THEN 'solo:' || c.server_id || ':' || c.album_id
               ELSE c.album_key
             END AS merge_key,
             c.priority_rank
           FROM candidates c
         ),
         winners AS (
           SELECT tid,
             ROW_NUMBER() OVER (PARTITION BY merge_key ORDER BY priority_rank) AS rn
           FROM partitioned
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
    params.append(&mut scope_params);
    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let albums: Vec<LibraryAlbumDto> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), map_album_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?;

    let has_more = albums.len() as u32 == limit;
    Ok(LibraryClusterAlbumsResponse { albums, has_more })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use crate::server_cluster::rebuild::rebuild_all_cluster_keys;

    fn track(
        server: &str,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        album_id: &str,
    ) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: Some(format!("art-{server}")),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: Some(artist.into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: Some(2020),
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
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
    fn merge_collapses_same_album_key_by_priority() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "A", "Band", "LP", "alb1"),
                track("s2", "t2", "B", "Band", "LP", "alb2"),
            ])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        let resp = list_merged_albums(
            &store,
            &["s1".into(), "s2".into()],
            50,
            0,
            &std::collections::HashMap::new(),
        )
        .unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].server_id, "s1");
    }
}
