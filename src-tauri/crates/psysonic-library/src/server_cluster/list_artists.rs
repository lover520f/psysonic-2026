//! Merged artist listing for cluster scope (spec §4 Tier 1 — dedup by `artist_key`).

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::dto::{LibraryArtistDto, LibraryClusterArtistsResponse};
use crate::search::PAGE_LIMIT_MAX;
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;
use super::library_scope::scope_filter_sql_and_params;
use super::priority::{in_list_sql, priority_case_sql};

pub fn list_merged_artists(
    store: &LibraryStore,
    servers_ordered: &[String],
    limit: u32,
    offset: u32,
    library_scopes: &std::collections::HashMap<String, String>,
) -> Result<LibraryClusterArtistsResponse, String> {
    if servers_ordered.is_empty() {
        return Ok(LibraryClusterArtistsResponse {
            artists: vec![],
            has_more: false,
        });
    }
    let limit = limit.clamp(1, PAGE_LIMIT_MAX);
    let offset = offset.min(i32::MAX as u32) as i32;
    let (in_placeholders, in_params) = in_list_sql(servers_ordered);
    let (priority_sql, priority_params) = priority_case_sql("c.server_id", servers_ordered);
    let (scope_sql, scope_params) = scope_filter_sql_and_params("t", servers_ordered, library_scopes);

    // Artist-first catalog: one row per artist (not per track), then merge by
    // `artist_key`. The previous track-scan + window over every row was O(tracks)
    // with correlated album counts and blocked the Artists browse page on large libs.
    let sql = format!(
        "WITH artist_keys AS (
           SELECT
             t.server_id,
             COALESCE(NULLIF(t.artist_id, ''), t.artist) AS artist_ref,
             MIN(k.artist_key) AS artist_key
           FROM track t
           INNER JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           WHERE t.deleted = 0
             AND t.server_id IN ({in_placeholders}){scope_sql}
             AND k.artist_key IS NOT NULL
           GROUP BY t.server_id, artist_ref
         ),
         track_artists AS (
           SELECT
             t.server_id,
             COALESCE(NULLIF(t.artist_id, ''), t.artist) AS id,
             MAX(t.artist) AS name,
             COUNT(DISTINCT CASE
               WHEN t.album_id IS NOT NULL AND t.album_id != '' THEN t.album_id
             END) AS album_count,
             MAX(t.synced_at) AS synced_at,
             CAST(NULL AS TEXT) AS raw_json
           FROM track t
           WHERE t.deleted = 0
             AND t.server_id IN ({in_placeholders}){scope_sql}
             AND COALESCE(t.artist, '') != ''
             AND NOT EXISTS (
               SELECT 1 FROM artist ar
                WHERE ar.server_id = t.server_id
                  AND ar.id = COALESCE(NULLIF(t.artist_id, ''), t.artist)
             )
           GROUP BY t.server_id, COALESCE(NULLIF(t.artist_id, ''), t.artist)
         ),
         catalog AS (
           SELECT ar.server_id, ar.id, ar.name, ar.album_count, ar.synced_at, ar.raw_json
             FROM artist ar
            WHERE ar.server_id IN ({in_placeholders})
           UNION ALL
           SELECT server_id, id, name, album_count, synced_at, raw_json
             FROM track_artists
         ),
         candidates AS (
           SELECT
             c.server_id,
             c.id,
             c.name,
             c.album_count,
             c.synced_at,
             c.raw_json,
             ({priority_sql}) AS priority_rank,
             CASE
               WHEN ak.artist_key IS NOT NULL THEN ak.artist_key
               ELSE 'solo:' || c.server_id || ':' || c.id
             END AS merge_key
           FROM catalog c
           LEFT JOIN artist_keys ak
             ON ak.server_id = c.server_id AND ak.artist_ref = c.id
         ),
         winners AS (
           SELECT
             server_id,
             id,
             name,
             album_count,
             synced_at,
             raw_json,
             ROW_NUMBER() OVER (PARTITION BY merge_key ORDER BY priority_rank) AS rn
           FROM candidates
         )
         SELECT server_id, id, name, album_count, synced_at, raw_json
           FROM winners
          WHERE rn = 1
          ORDER BY name COLLATE NOCASE, server_id
          LIMIT ? OFFSET ?",
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(in_params.iter().cloned());
    params.extend(scope_params.iter().cloned());
    params.extend(in_params.iter().cloned());
    params.extend(scope_params.iter().cloned());
    params.extend(in_params.iter().cloned());
    params.extend(priority_params);
    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let artists: Vec<LibraryArtistDto> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), map_artist_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?;

    let has_more = artists.len() as u32 == limit;
    Ok(LibraryClusterArtistsResponse { artists, has_more })
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

    fn track(server: &str, id: &str, artist: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: "Song".into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: Some(format!("art-{server}")),
            album: "LP".into(),
            album_id: Some("alb1".into()),
            album_artist: Some(artist.into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
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
    fn merge_collapses_same_artist_key_by_priority() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Band"), track("s2", "t2", "Band")])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        let resp = list_merged_artists(&store, &["s1".into(), "s2".into()], 50, 0, &std::collections::HashMap::new()).unwrap();
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].server_id, "s1");
    }

    #[test]
    fn prefers_artist_table_album_count_when_present() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Band"), track("s2", "t2", "Band")])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();
        store
            .with_conn("test", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, album_count, synced_at, raw_json) \
                     VALUES ('s1', 'art-s1', 'Band', 3, 1, '{}'), \
                            ('s2', 'art-s2', 'Band', 2, 1, '{}')",
                    [],
                )
            })
            .unwrap();

        let resp = list_merged_artists(&store, &["s1".into(), "s2".into()], 50, 0, &std::collections::HashMap::new()).unwrap();
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].server_id, "s1");
        assert_eq!(resp.artists[0].album_count, Some(3));
    }
}
