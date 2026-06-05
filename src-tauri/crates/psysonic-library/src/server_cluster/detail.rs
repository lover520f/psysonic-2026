//! Virtual aggregate detail pages for cluster scope (spec §4 — `/album/:id`, `/artist/:id`).

use rusqlite::types::Value as SqlValue;
use rusqlite::OptionalExtension;
use serde_json::Value;

use crate::dto::{
    LibraryAlbumDto, LibraryArtistDto, LibraryClusterAlbumDetailResponse,
    LibraryClusterArtistDetailResponse, LibraryTrackDto,
};
use crate::repos;
use crate::search::aliased_track_columns;
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;
use super::keys::artist_key_from_display_name;
use super::list_albums::list_merged_albums;
use super::merge::{solo_partition_key, DURATION_TOLERANCE_SEC};
use super::priority::{in_list_sql, priority_case_sql};

const TOP_TRACKS_LIMIT: u32 = 50;

/// Resolve `(server_id, album_id)` seed — prefer explicit server when it holds the album.
fn resolve_album_seed(
    store: &LibraryStore,
    servers_ordered: &[String],
    seed_server_id: &str,
    seed_album_id: &str,
) -> Result<Option<(String, String)>, String> {
    if servers_ordered.is_empty() || seed_album_id.is_empty() {
        return Ok(None);
    }
    let try_order: Vec<&str> = if servers_ordered.iter().any(|s| s == seed_server_id) {
        std::iter::once(seed_server_id)
            .chain(servers_ordered.iter().map(String::as_str).filter(|s| *s != seed_server_id))
            .collect()
    } else {
        servers_ordered.iter().map(String::as_str).collect()
    };
    for sid in try_order {
        let exists: bool = store.with_read_conn(|conn| {
            conn.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM track
                    WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0 LIMIT 1
                 )",
                rusqlite::params![sid, seed_album_id],
                |row| row.get(0),
            )
        })?;
        if exists {
            return Ok(Some((sid.to_string(), seed_album_id.to_string())));
        }
    }
    Ok(None)
}

fn album_key_for_pair(
    store: &LibraryStore,
    server_id: &str,
    album_id: &str,
) -> Result<Option<String>, String> {
    store.with_read_conn(|conn| {
        conn.query_row(
            &format!(
                "SELECT k.album_key FROM track t
                  JOIN {ATTACH_ALIAS}.track_cluster_key k
                    ON k.server_id = t.server_id AND k.track_id = t.id
                 WHERE t.server_id = ?1 AND t.album_id = ?2 AND t.deleted = 0
                   AND k.album_key IS NOT NULL
                 LIMIT 1"
            ),
            rusqlite::params![server_id, album_id],
            |r| r.get(0),
        )
        .optional()
    })
    .map_err(|e| e.to_string())
}

fn member_album_pairs(
    store: &LibraryStore,
    servers_ordered: &[String],
    merge_key: &str,
    solo_seed: Option<(&str, &str)>,
) -> Result<Vec<(String, String, u32)>, String> {
    if servers_ordered.is_empty() {
        return Ok(Vec::new());
    }
    if let Some((sid, aid)) = solo_seed {
        if merge_key == solo_partition_key(sid, aid) {
            let rank = servers_ordered
                .iter()
                .position(|s| s == sid)
                .unwrap_or(9999) as u32;
            return Ok(vec![(sid.to_string(), aid.to_string(), rank)]);
        }
    }

    let (in_placeholders, in_params) = in_list_sql(servers_ordered);
    let (priority_sql, priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let sql = format!(
        "SELECT DISTINCT t.server_id, t.album_id, ({priority_sql}) AS priority_rank
           FROM track t
           JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
          WHERE t.deleted = 0
            AND t.server_id IN ({in_placeholders})
            AND t.album_id IS NOT NULL AND t.album_id != ''
            AND k.album_key = ?
          ORDER BY priority_rank, t.server_id, t.album_id"
    );
    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(priority_params);
    params.extend(in_params);
    params.push(SqlValue::Text(merge_key.to_string()));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u32))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(|e| e.to_string())
}

fn load_album_row(
    store: &LibraryStore,
    server_id: &str,
    album_id: &str,
) -> Result<Option<LibraryAlbumDto>, String> {
    let sql = "SELECT
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
           COALESCE(a.starred_at, (
             SELECT MIN(c.starred_at) FROM track c
              WHERE c.server_id = t.server_id AND c.album_id = t.album_id
                AND c.deleted = 0 AND c.starred_at IS NOT NULL
           )),
           COALESCE(a.synced_at, t.synced_at),
           a.raw_json
         FROM track t
         LEFT JOIN album a ON a.server_id = t.server_id AND a.id = t.album_id
        WHERE t.server_id = ?1 AND t.album_id = ?2 AND t.deleted = 0
        LIMIT 1";

    store
        .with_read_conn(|conn| {
            conn.query_row(sql, rusqlite::params![server_id, album_id], |r| {
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
            })
            .optional()
        })
        .map_err(|e| e.to_string())
}

fn coalesce_opt<T: Clone>(values: &[Option<T>]) -> Option<T> {
    values.iter().find_map(|v| v.clone())
}

fn coalesce_str(values: &[Option<String>]) -> Option<String> {
    values
        .iter()
        .find_map(|v| v.as_ref().filter(|s| !s.is_empty()).cloned())
}

fn merge_album_metadata(rows: &[LibraryAlbumDto]) -> Option<LibraryAlbumDto> {
    if rows.is_empty() {
        return None;
    }
    let owner = rows[0].clone();
    let names: Vec<Option<String>> = rows.iter().map(|r| Some(r.name.clone())).collect();
    let artists: Vec<Option<String>> = rows.iter().map(|r| r.artist.clone()).collect();
    let artist_ids: Vec<Option<String>> = rows.iter().map(|r| r.artist_id.clone()).collect();
    let years: Vec<Option<i64>> = rows.iter().map(|r| r.year).collect();
    let genres: Vec<Option<String>> = rows.iter().map(|r| r.genre.clone()).collect();
    let covers: Vec<Option<String>> = rows.iter().map(|r| r.cover_art_id.clone()).collect();
    Some(LibraryAlbumDto {
        server_id: owner.server_id.clone(),
        id: owner.id.clone(),
        name: coalesce_str(&names).unwrap_or(owner.name),
        artist: coalesce_opt(&artists),
        artist_id: coalesce_opt(&artist_ids),
        song_count: None, // filled after track merge
        duration_sec: None,
        year: coalesce_opt(&years),
        genre: coalesce_str(&genres),
        cover_art_id: coalesce_opt(&covers),
        starred_at: rows.iter().filter_map(|r| r.starred_at).min(),
        synced_at: rows.iter().map(|r| r.synced_at).max().unwrap_or(owner.synced_at),
        raw_json: owner.raw_json.clone(),
    })
}

fn merged_tracks_for_album_pairs(
    store: &LibraryStore,
    servers_ordered: &[String],
    pairs: &[(String, String, u32)],
) -> Result<Vec<LibraryTrackDto>, String> {
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    let (priority_sql, priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let pair_clauses: Vec<String> = pairs
        .iter()
        .map(|_| "(t.server_id = ? AND t.album_id = ?)".to_string())
        .collect();
    let pair_filter = pair_clauses.join(" OR ");

    let cols = aliased_track_columns("t");
    let sql = format!(
        "WITH candidates AS (
           SELECT
             t.rowid AS tid,
             t.server_id,
             t.id AS track_id,
             k.cluster_key,
             COALESCE(k.duration_sec, t.duration_sec) AS dur,
             ({priority_sql}) AS priority_rank
           FROM track t
           LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           WHERE t.deleted = 0 AND ({pair_filter})
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
         winners AS (
           SELECT tid,
             ROW_NUMBER() OVER (PARTITION BY merge_key ORDER BY priority_rank) AS rn
           FROM partitioned
         )
         SELECT {cols}
           FROM winners w
           JOIN track t ON t.rowid = w.tid
          WHERE w.rn = 1
          ORDER BY COALESCE(t.disc_number, 1), COALESCE(t.track_number, 9999), t.title COLLATE NOCASE",
        tol = DURATION_TOLERANCE_SEC,
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(priority_params);
    for (sid, aid, _) in pairs {
        params.push(SqlValue::Text(sid.clone()));
        params.push(SqlValue::Text(aid.clone()));
    }

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(|e| e.to_string())
}

pub fn cluster_album_detail(
    store: &LibraryStore,
    servers_ordered: &[String],
    seed_server_id: &str,
    seed_album_id: &str,
) -> Result<LibraryClusterAlbumDetailResponse, String> {
    let Some((seed_sid, seed_aid)) =
        resolve_album_seed(store, servers_ordered, seed_server_id, seed_album_id)?
    else {
        return Err("album not found in cluster scope".to_string());
    };

    let album_key = album_key_for_pair(store, &seed_sid, &seed_aid)?;
    let merge_key = album_key
        .clone()
        .unwrap_or_else(|| solo_partition_key(&seed_sid, &seed_aid));
    let solo = album_key.is_none().then_some((seed_sid.as_str(), seed_aid.as_str()));

    let pairs = member_album_pairs(store, servers_ordered, &merge_key, solo)?;
    if pairs.is_empty() {
        return Err("album not found in cluster scope".to_string());
    }

    let owner_sid = pairs[0].0.clone();
    let owner_aid = pairs[0].1.clone();

    let mut album_rows = Vec::with_capacity(pairs.len());
    for (sid, aid, _) in &pairs {
        if let Some(row) = load_album_row(store, sid, aid)? {
            album_rows.push(row);
        }
    }
    let mut album = merge_album_metadata(&album_rows).ok_or_else(|| "album metadata missing".to_string())?;
    album.server_id = owner_sid.clone();
    album.id = owner_aid.clone();

    let tracks = merged_tracks_for_album_pairs(store, servers_ordered, &pairs)?;
    album.song_count = Some(tracks.len() as i64);
    album.duration_sec = Some(tracks.iter().map(|t| t.duration_sec).sum());

    let related = list_related_albums(store, servers_ordered, &album, &merge_key)?;

    Ok(LibraryClusterAlbumDetailResponse {
        album,
        tracks,
        owner_server_id: owner_sid,
        related_albums: related,
    })
}

fn list_related_albums(
    store: &LibraryStore,
    servers_ordered: &[String],
    album: &LibraryAlbumDto,
    _exclude_merge_key: &str,
) -> Result<Vec<LibraryAlbumDto>, String> {
    let artist_id = album.artist_id.as_deref().unwrap_or("");
    let artist_name = album.artist.as_deref().unwrap_or("");
    if artist_id.is_empty() && artist_name.is_empty() {
        return Ok(Vec::new());
    }
    let resp = list_merged_albums(store, servers_ordered, 500, 0, &std::collections::HashMap::new())?;
    Ok(resp
        .albums
        .into_iter()
        .filter(|a| {
            if a.id == album.id && a.server_id == album.server_id {
                return false;
            }
            let has_artist_id = artist_id.chars().any(|c| !c.is_whitespace());
            let same_artist = (has_artist_id && a.artist_id.as_deref() == Some(artist_id))
                || (!artist_name.is_empty()
                    && a.artist.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(artist_name)));
            same_artist
        })
        .take(100)
        .collect())
}

// --- Artist detail ---

fn resolve_artist_seed(
    store: &LibraryStore,
    servers_ordered: &[String],
    seed_server_id: &str,
    seed_artist_id: &str,
) -> Result<Option<(String, String)>, String> {
    if servers_ordered.is_empty() || seed_artist_id.is_empty() {
        return Ok(None);
    }
    let try_order: Vec<&str> = if servers_ordered.iter().any(|s| s == seed_server_id) {
        std::iter::once(seed_server_id)
            .chain(servers_ordered.iter().map(String::as_str).filter(|s| *s != seed_server_id))
            .collect()
    } else {
        servers_ordered.iter().map(String::as_str).collect()
    };
    for sid in try_order {
        let exists: bool = store.with_read_conn(|conn| {
            conn.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM artist ar
                    WHERE ar.server_id = ?1 AND ar.id = ?2
                 ) OR EXISTS(
                   SELECT 1 FROM track
                    WHERE server_id = ?1 AND deleted = 0
                      AND (artist_id = ?2 OR artist = ?2)
                    LIMIT 1
                 )",
                rusqlite::params![sid, seed_artist_id],
                |row| row.get(0),
            )
        })?;
        if exists {
            return Ok(Some((sid.to_string(), seed_artist_id.to_string())));
        }
    }
    Ok(None)
}

fn artist_key_for_pair(
    store: &LibraryStore,
    server_id: &str,
    artist_ref: &str,
) -> Result<Option<String>, String> {
    store.with_read_conn(|conn| {
        conn.query_row(
            &format!(
                "SELECT k.artist_key FROM track t
                  JOIN {ATTACH_ALIAS}.track_cluster_key k
                    ON k.server_id = t.server_id AND k.track_id = t.id
                 WHERE t.server_id = ?1 AND t.deleted = 0
                   AND (t.artist_id = ?2 OR t.artist = ?2)
                   AND k.artist_key IS NOT NULL
                 LIMIT 1"
            ),
            rusqlite::params![server_id, artist_ref],
            |r| r.get(0),
        )
        .optional()
    })
    .map_err(|e| e.to_string())
}

fn load_artist_row(
    store: &LibraryStore,
    server_id: &str,
    artist_id: &str,
) -> Result<Option<LibraryArtistDto>, String> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT
                   ar.server_id,
                   ar.id,
                   ar.name,
                   ar.album_count,
                   ar.synced_at,
                   ar.raw_json
                 FROM artist ar
                WHERE ar.server_id = ?1 AND ar.id = ?2",
                rusqlite::params![server_id, artist_id],
                |r| {
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
                },
            )
            .optional()
        })
        .map_err(|e| e.to_string())
}

fn fallback_artist_from_tracks(
    store: &LibraryStore,
    server_id: &str,
    artist_ref: &str,
) -> Result<Option<LibraryArtistDto>, String> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT
                   t.server_id,
                   COALESCE(NULLIF(t.artist_id, ''), t.artist),
                   COALESCE(t.artist, ''),
                   COUNT(DISTINCT t.album_id),
                   MAX(t.synced_at)
                 FROM track t
                WHERE t.server_id = ?1 AND t.deleted = 0
                  AND (t.artist_id = ?2 OR t.artist = ?2)
                GROUP BY t.server_id, COALESCE(NULLIF(t.artist_id, ''), t.artist)",
                rusqlite::params![server_id, artist_ref],
                |r| {
                    Ok(LibraryArtistDto {
                        server_id: r.get(0)?,
                        id: r.get(1)?,
                        name: r.get(2)?,
                        album_count: Some(r.get(3)?),
                        synced_at: r.get(4)?,
                        raw_json: Value::Null,
                    })
                },
            )
            .optional()
        })
        .map_err(|e| e.to_string())
}

fn merged_albums_for_artist_key(
    store: &LibraryStore,
    servers_ordered: &[String],
    artist_key: &str,
) -> Result<Vec<LibraryAlbumDto>, String> {
    if servers_ordered.is_empty() {
        return Ok(Vec::new());
    }
    let (in_placeholders, in_params) = in_list_sql(servers_ordered);
    let (priority_sql, priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let sql = format!(
        "WITH candidates AS (
           SELECT
             t.rowid AS tid,
             t.server_id,
             t.album_id,
             k.album_key,
             ({priority_sql}) AS priority_rank
           FROM track t
           JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           WHERE t.deleted = 0
             AND t.server_id IN ({in_placeholders})
             AND k.artist_key = ?
             AND t.album_id IS NOT NULL AND t.album_id != ''
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
        ORDER BY COALESCE(a.name, t.album) COLLATE NOCASE",
    );
    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(priority_params);
    params.extend(in_params);
    params.push(SqlValue::Text(artist_key.to_string()));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
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
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(|e| e.to_string())
}

fn merged_top_tracks_for_artist_key(
    store: &LibraryStore,
    servers_ordered: &[String],
    artist_key: &str,
    limit: u32,
) -> Result<Vec<LibraryTrackDto>, String> {
    if servers_ordered.is_empty() {
        return Ok(Vec::new());
    }
    let (in_placeholders, in_params) = in_list_sql(servers_ordered);
    let (priority_sql, priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let cols = aliased_track_columns("t");
    let sql = format!(
        "WITH candidates AS (
           SELECT
             t.rowid AS tid,
             t.server_id,
             t.id AS track_id,
             k.cluster_key,
             COALESCE(k.duration_sec, t.duration_sec) AS dur,
             ({priority_sql}) AS priority_rank,
             COALESCE(t.play_count, 0) AS play_count
           FROM track t
           JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = t.server_id AND k.track_id = t.id
           WHERE t.deleted = 0
             AND t.server_id IN ({in_placeholders})
             AND k.artist_key = ?
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
           SELECT c.tid, c.play_count,
             CASE
               WHEN c.cluster_key IS NULL THEN 'solo:' || c.server_id || ':' || c.track_id
               WHEN ABS(c.dur - rd.ref_dur) <= {tol} THEN c.cluster_key
               ELSE 'solo:' || c.server_id || ':' || c.track_id
             END AS merge_key,
             c.priority_rank
           FROM candidates c
           LEFT JOIN ref_dur rd ON c.cluster_key = rd.cluster_key
         ),
         winners AS (
           SELECT tid, play_count,
             ROW_NUMBER() OVER (PARTITION BY merge_key ORDER BY priority_rank) AS rn
           FROM partitioned
         )
         SELECT {cols}
           FROM winners w
           JOIN track t ON t.rowid = w.tid
          WHERE w.rn = 1
          ORDER BY w.play_count DESC, t.title COLLATE NOCASE
          LIMIT ?",
        tol = DURATION_TOLERANCE_SEC,
    );
    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(priority_params);
    params.extend(in_params);
    params.push(SqlValue::Text(artist_key.to_string()));
    params.push(SqlValue::Integer(limit as i64));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(|e| e.to_string())
}

/// Album rows for an artist when cluster-key merge yields nothing — match the
/// `album` table (and track-only albums) by artist id or display name.
fn fallback_albums_for_artist_scope(
    store: &LibraryStore,
    servers_ordered: &[String],
    artist_ref: &str,
    artist_name: &str,
) -> Result<Vec<LibraryAlbumDto>, String> {
    if servers_ordered.is_empty() {
        return Ok(Vec::new());
    }
    let (in_placeholders, in_params) = in_list_sql(servers_ordered);
    let album_sql = format!(
        "SELECT
           a.server_id,
           a.id,
           a.name,
           a.artist,
           a.artist_id,
           a.song_count,
           a.duration_sec,
           a.year,
           a.genre,
           a.cover_art_id,
           a.starred_at,
           a.synced_at,
           a.raw_json
         FROM album a
        WHERE a.server_id IN ({in_placeholders})
          AND (a.artist_id = ? OR a.artist = ? OR a.artist = ?)
        ORDER BY a.name COLLATE NOCASE, a.server_id",
    );
    let mut album_params: Vec<SqlValue> = Vec::new();
    album_params.extend(in_params.clone());
    album_params.push(SqlValue::Text(artist_ref.to_string()));
    album_params.push(SqlValue::Text(artist_ref.to_string()));
    album_params.push(SqlValue::Text(artist_name.to_string()));

    let from_table: Vec<LibraryAlbumDto> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&album_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(album_params.iter()), map_album_dto_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?;
    if !from_table.is_empty() {
        return Ok(from_table);
    }

    let (priority_sql, priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let track_sql = format!(
        "WITH picks AS (
           SELECT t.server_id, t.album_id, MIN(t.rowid) AS tid
             FROM track t
            WHERE t.deleted = 0
              AND t.server_id IN ({in_placeholders})
              AND t.album_id IS NOT NULL AND t.album_id != ''
              AND (t.artist_id = ? OR t.artist = ? OR t.artist_id = ?)
            GROUP BY t.server_id, t.album_id
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
         FROM picks p
         JOIN track t ON t.rowid = p.tid
         LEFT JOIN album a ON a.server_id = t.server_id AND a.id = t.album_id
        ORDER BY ({priority_sql}), COALESCE(a.name, t.album) COLLATE NOCASE",
    );
    let mut track_params: Vec<SqlValue> = Vec::new();
    track_params.extend(in_params);
    track_params.push(SqlValue::Text(artist_ref.to_string()));
    track_params.push(SqlValue::Text(artist_name.to_string()));
    track_params.push(SqlValue::Text(artist_ref.to_string()));
    track_params.extend(priority_params);

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&track_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(track_params.iter()), map_album_dto_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(|e| e.to_string())
}

fn map_album_dto_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
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

fn fallback_top_tracks_for_artist_scope(
    store: &LibraryStore,
    servers_ordered: &[String],
    artist_ref: &str,
    artist_name: &str,
    limit: u32,
) -> Result<Vec<LibraryTrackDto>, String> {
    if servers_ordered.is_empty() {
        return Ok(Vec::new());
    }
    let (in_placeholders, in_params) = in_list_sql(servers_ordered);
    let (priority_sql, priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let sql = format!(
        "SELECT {cols}
           FROM track t
          WHERE t.deleted = 0
            AND t.server_id IN ({in_placeholders})
            AND (t.artist_id = ? OR t.artist = ? OR t.artist_id = ?)
          ORDER BY ({priority_sql}), COALESCE(t.play_count, 0) DESC, t.title COLLATE NOCASE
          LIMIT ?",
        cols = aliased_track_columns("t"),
    );
    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(priority_params);
    params.extend(in_params);
    params.push(SqlValue::Text(artist_ref.to_string()));
    params.push(SqlValue::Text(artist_name.to_string()));
    params.push(SqlValue::Text(artist_ref.to_string()));
    params.push(SqlValue::Integer(limit as i64));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(|e| e.to_string())
}

pub fn cluster_artist_detail(
    store: &LibraryStore,
    servers_ordered: &[String],
    seed_server_id: &str,
    seed_artist_id: &str,
) -> Result<LibraryClusterArtistDetailResponse, String> {
    let Some((seed_sid, seed_aid)) =
        resolve_artist_seed(store, servers_ordered, seed_server_id, seed_artist_id)?
    else {
        return Err("artist not found in cluster scope".to_string());
    };

    let owner_sid = seed_sid.clone();
    let owner_aid = seed_aid.clone();

    let artist = load_artist_row(store, &owner_sid, &owner_aid)?
        .or_else(|| fallback_artist_from_tracks(store, &owner_sid, &owner_aid).ok().flatten())
        .ok_or_else(|| "artist metadata missing".to_string())?;

    let mut artist_key = artist_key_for_pair(store, &owner_sid, &owner_aid)?;
    if artist_key.is_none() {
        artist_key = artist_key_from_display_name(&artist.name);
    }

    let mut albums = if let Some(ref key) = artist_key {
        merged_albums_for_artist_key(store, servers_ordered, key)?
    } else {
        Vec::new()
    };
    if albums.is_empty() {
        albums = fallback_albums_for_artist_scope(
            store,
            servers_ordered,
            &owner_aid,
            &artist.name,
        )?;
    }

    let mut top_tracks = if let Some(ref key) = artist_key {
        merged_top_tracks_for_artist_key(store, servers_ordered, key, TOP_TRACKS_LIMIT)?
    } else {
        Vec::new()
    };
    if top_tracks.is_empty() {
        top_tracks = fallback_top_tracks_for_artist_scope(
            store,
            servers_ordered,
            &owner_aid,
            &artist.name,
            TOP_TRACKS_LIMIT,
        )?;
    }

    Ok(LibraryClusterArtistDetailResponse {
        artist,
        albums,
        top_tracks,
        owner_server_id: owner_sid,
        artist_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use crate::server_cluster::rebuild::rebuild_all_cluster_keys;

    #[allow(clippy::too_many_arguments)]
    fn track(
        server: &str,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        album_id: &str,
        disc: i64,
        track_no: i64,
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
            track_number: Some(track_no),
            disc_number: Some(disc),
            year: Some(2020),
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: Some(1),
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
    fn album_detail_merges_tracks_and_picks_owner() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "One", "Band", "LP", "alb1", 1, 1),
                track("s1", "t2", "Two", "Band", "LP", "alb1", 1, 2),
                track("s2", "t3", "One", "Band", "LP", "alb2", 1, 1),
                track("s2", "t4", "Exclusive", "Band", "LP", "alb2", 1, 3),
            ])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        let resp = cluster_album_detail(&store, &["s1".into(), "s2".into()], "s1", "alb1").unwrap();
        assert_eq!(resp.owner_server_id, "s1");
        assert_eq!(resp.tracks.len(), 3);
        assert_eq!(resp.tracks[0].title, "One");
        assert_eq!(resp.tracks[2].title, "Exclusive");
    }

    #[test]
    fn artist_detail_lists_merged_albums() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "A", "Band", "LP1", "alb1", 1, 1),
                track("s2", "t2", "B", "Band", "LP1", "alb2", 1, 1),
                track("s1", "t3", "C", "Band", "LP2", "alb3", 1, 1),
            ])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        let resp =
            cluster_artist_detail(&store, &["s1".into(), "s2".into()], "s1", "art-s1").unwrap();
        assert_eq!(resp.albums.len(), 2);
        assert!(!resp.top_tracks.is_empty());
    }
}
