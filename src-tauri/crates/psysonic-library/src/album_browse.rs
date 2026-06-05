//! Paginated All Albums browse from the local index (plain, no filters).
//!
//! Prefers the synced `album` table (≈5k rows) with LIMIT/OFFSET. Falls back to
//! track `GROUP BY` only when the album catalog is not populated (N1 ingest).

use crate::dto::{
    LibraryAlbumBrowseRequest, LibraryAlbumBrowseResponse, LibraryAlbumDto, LibrarySortClause,
    SortDir,
};
use crate::search::library_scope_filter_sql;
use crate::store::LibraryStore;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

fn trimmed_nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn effective_scope_ids(req: &LibraryAlbumBrowseRequest) -> Vec<String> {
    if let Some(ids) = &req.library_scope_ids {
        let trimmed: Vec<_> = ids
            .iter()
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .collect();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    trimmed_nonempty(req.library_scope.as_deref())
        .map(|s| vec![s])
        .unwrap_or_default()
}

fn album_table_order_sql(sort: &[LibrarySortClause]) -> String {
    let mut keys: Vec<String> = Vec::new();
    for s in sort {
        let col = match s.field.as_str() {
            "name" => "a.name COLLATE NOCASE",
            "artist" => "a.artist COLLATE NOCASE",
            "year" => "a.year",
            _ => continue,
        };
        let dir = match s.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        keys.push(format!("{col} {dir}"));
    }
    if keys.is_empty() {
        keys.push("a.name COLLATE NOCASE ASC".to_string());
    }
    keys.push("a.id ASC".to_string());
    format!("ORDER BY {}", keys.join(", "))
}

fn track_group_order_sql(sort: &[LibrarySortClause]) -> String {
    let mut keys: Vec<String> = Vec::new();
    for s in sort {
        let col = match s.field.as_str() {
            "name" => "COALESCE(a.name, la.album_name) COLLATE NOCASE",
            "artist" => "COALESCE(a.artist, la.artist) COLLATE NOCASE",
            "year" => "COALESCE(a.year, la.year)",
            _ => continue,
        };
        let dir = match s.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        keys.push(format!("{col} {dir}"));
    }
    if keys.is_empty() {
        keys.push("COALESCE(a.name, la.album_name) COLLATE NOCASE ASC".to_string());
    }
    keys.push("la.album_id ASC".to_string());
    format!("ORDER BY {}", keys.join(", "))
}

fn push_album_id_allowlist(
    where_clauses: &mut Vec<String>,
    params: &mut Vec<SqlValue>,
    column: &str,
    ids: Option<&[String]>,
) {
    let Some(ids) = ids else {
        return;
    };
    if ids.is_empty() {
        where_clauses.push("1 = 0".to_string());
        return;
    }
    let placeholders = (0..ids.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    where_clauses.push(format!("{column} IN ({placeholders})"));
    for id in ids {
        params.push(SqlValue::Text(id.clone()));
    }
}

/// `album` rows have no `library_id`; scope is enforced via matching tracks.
fn push_album_table_library_scope(
    where_clauses: &mut Vec<String>,
    params: &mut Vec<SqlValue>,
    scope_ids: &[String],
) {
    if scope_ids.is_empty() {
        return;
    }
    let (clause, scope_params) = library_scope_filter_sql("t_scope", scope_ids);
    let Some(scope_clause) = clause else {
        return;
    };
    where_clauses.push(format!(
        "EXISTS (SELECT 1 FROM track t_scope \
         WHERE t_scope.server_id = a.server_id \
           AND t_scope.album_id = a.id \
           AND t_scope.deleted = 0 \
           AND {scope_clause})"
    ));
    params.extend(scope_params);
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
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
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null),
    })
}

pub(crate) fn album_table_usable(store: &LibraryStore, server_id: &str) -> Result<bool, String> {
    store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM album
                   WHERE server_id = ?1 AND song_count IS NOT NULL
                   LIMIT 1
                 )",
                rusqlite::params![server_id],
                |r| r.get(0),
            )
        })
        .map_err(|e| e.to_string())
}

fn list_albums_from_table(
    store: &LibraryStore,
    req: &LibraryAlbumBrowseRequest,
) -> Result<LibraryAlbumBrowseResponse, String> {
    let limit = req.limit.max(1);
    let offset = req.offset;
    let order_sql = album_table_order_sql(&req.sort);

    let mut where_clauses = vec!["a.server_id = ?1".to_string()];
    let mut params: Vec<SqlValue> = vec![SqlValue::Text(req.server_id.clone())];

    let scope_ids = effective_scope_ids(req);
    push_album_table_library_scope(&mut where_clauses, &mut params, &scope_ids);
    push_album_id_allowlist(
        &mut where_clauses,
        &mut params,
        "a.id",
        req.restrict_album_ids.as_deref(),
    );

    let where_sql = where_clauses.join(" AND ");
    let sql = format!(
        "SELECT \
           a.server_id, \
           a.id, \
           a.name, \
           a.artist, \
           a.artist_id, \
           a.song_count, \
           a.duration_sec, \
           a.year, \
           a.genre, \
           a.cover_art_id, \
           a.starred_at, \
           a.synced_at, \
           a.raw_json \
         FROM album a \
         WHERE {where_sql} \
         {order_sql} \
         LIMIT ? OFFSET ?"
    );

    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let albums: Vec<LibraryAlbumDto> = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), map_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?;

    let has_more = albums.len() as u32 == limit;
    Ok(LibraryAlbumBrowseResponse {
        albums,
        has_more,
        source: "local".to_string(),
    })
}

fn list_albums_from_tracks(
    store: &LibraryStore,
    req: &LibraryAlbumBrowseRequest,
) -> Result<LibraryAlbumBrowseResponse, String> {
    let limit = req.limit.max(1);
    let offset = req.offset;
    let order_sql = track_group_order_sql(&req.sort);

    let mut where_clauses = vec![
        "t.deleted = 0".to_string(),
        "t.server_id = ?1".to_string(),
        "t.album_id IS NOT NULL AND t.album_id != ''".to_string(),
    ];
    let mut params: Vec<SqlValue> = vec![SqlValue::Text(req.server_id.clone())];

    let scope_ids = effective_scope_ids(req);
    if let (Some(clause), scope_params) = library_scope_filter_sql("t", &scope_ids) {
        where_clauses.push(clause);
        params.extend(scope_params);
    }
    push_album_id_allowlist(
        &mut where_clauses,
        &mut params,
        "t.album_id",
        req.restrict_album_ids.as_deref(),
    );

    let where_sql = where_clauses.join(" AND ");
    let sql = format!(
        "SELECT \
           la.server_id, \
           la.album_id, \
           COALESCE(a.name, la.album_name), \
           COALESCE(a.artist, la.artist), \
           COALESCE(a.artist_id, la.artist_id), \
           COALESCE(a.song_count, la.track_count), \
           COALESCE(a.duration_sec, la.duration_sec), \
           COALESCE(a.year, la.year), \
           COALESCE(a.genre, la.genre), \
           COALESCE(a.cover_art_id, la.cover_art_id), \
           COALESCE(a.starred_at, la.starred_at), \
           COALESCE(a.synced_at, la.synced_at), \
           a.raw_json \
         FROM ( \
           SELECT \
             t.server_id, \
             t.album_id, \
             MAX(t.album) AS album_name, \
             MAX(t.artist) AS artist, \
             MAX(t.artist_id) AS artist_id, \
             MAX(t.year) AS year, \
             MAX(t.genre) AS genre, \
             MAX(t.cover_art_id) AS cover_art_id, \
             MAX(t.starred_at) AS starred_at, \
             MAX(t.synced_at) AS synced_at, \
             COUNT(*) AS track_count, \
             COALESCE(SUM(t.duration_sec), 0) AS duration_sec \
           FROM track t \
           WHERE {where_sql} \
           GROUP BY t.server_id, t.album_id \
         ) la \
         LEFT JOIN album a ON a.server_id = la.server_id AND a.id = la.album_id \
         {order_sql} \
         LIMIT ? OFFSET ?"
    );

    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let albums: Vec<LibraryAlbumDto> = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), map_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?;

    let has_more = albums.len() as u32 == limit;
    Ok(LibraryAlbumBrowseResponse {
        albums,
        has_more,
        source: "local".to_string(),
    })
}

fn browse_is_scoped(req: &LibraryAlbumBrowseRequest) -> bool {
    !effective_scope_ids(req).is_empty()
        || req
            .restrict_album_ids
            .as_ref()
            .is_some_and(|ids| !ids.is_empty())
}

pub fn list_albums(
    store: &LibraryStore,
    req: &LibraryAlbumBrowseRequest,
) -> Result<LibraryAlbumBrowseResponse, String> {
    let scope_ids = effective_scope_ids(req);
    // Unscoped, or a single library: `album` table + EXISTS (fast on ~5k rows).
    // Multi-library union: filter tracks by `library_id IN (...)` then GROUP BY.
    if album_table_usable(store, &req.server_id)?
        && (!browse_is_scoped(req) || scope_ids.len() == 1)
    {
        return list_albums_from_table(store, req);
    }
    if !crate::dto::track_index_nonempty(store, &req.server_id)? {
        return Ok(LibraryAlbumBrowseResponse {
            albums: Vec::new(),
            has_more: false,
            source: "local".to_string(),
        });
    }
    list_albums_from_tracks(store, req)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

    fn track(server: &str, id: &str, album_id: &str, album: &str, library_id: Option<&str>) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: format!("{album} track"),
            title_sort: None,
            artist: Some("Band".into()),
            artist_id: Some("art-1".into()),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: Some("Band".into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: Some(2020),
            genre: None,
            suffix: Some("mp3".into()),
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: library_id.map(String::from),
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

    fn req(server: &str, limit: u32, offset: u32) -> LibraryAlbumBrowseRequest {
        LibraryAlbumBrowseRequest {
            server_id: server.into(),
            library_scope: None,
            library_scope_ids: None,
            sort: Vec::new(),
            restrict_album_ids: None,
            limit,
            offset,
        }
    }

    fn seed_album(
        store: &LibraryStore,
        server_id: &str,
        id: &str,
        name: &str,
        song_count: i64,
    ) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, artist, song_count, duration_sec, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, 'Band', ?4, 400, 1, '{}')",
                    rusqlite::params![server_id, id, name, song_count],
                )
            })
            .unwrap();
    }

    #[test]
    fn lists_albums_grouped_from_tracks() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "al-1", "Alpha", None),
                track("s1", "t2", "al-2", "Beta", None),
            ])
            .unwrap();

        let resp = list_albums(&store, &req("s1", 50, 0)).unwrap();
        assert_eq!(resp.albums.len(), 2);
        assert!(!resp.has_more);
    }

    #[test]
    fn prefers_album_table_when_synced_catalog_exists() {
        let store = LibraryStore::open_in_memory();
        seed_album(&store, "s1", "al-1", "Alpha", 10);
        seed_album(&store, "s1", "al-2", "Beta", 8);

        let resp = list_albums(&store, &req("s1", 50, 0)).unwrap();
        assert_eq!(resp.albums.len(), 2);
        assert_eq!(resp.albums[0].name, "Alpha");
        assert_eq!(resp.albums[1].name, "Beta");
    }

    #[test]
    fn library_scope_narrows_results() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "al-1", "In", Some("lib-a")),
                track("s1", "t2", "al-2", "Out", Some("lib-b")),
            ])
            .unwrap();
        seed_album(&store, "s1", "al-1", "In", 1);
        seed_album(&store, "s1", "al-2", "Out", 1);

        let mut scoped = req("s1", 50, 0);
        scoped.library_scope_ids = Some(vec!["lib-a".into()]);
        let resp = list_albums(&store, &scoped).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al-1");
    }

    #[test]
    fn multi_library_scope_unions_albums() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "al-1", "Alpha", Some("lib-a")),
                track("s1", "t2", "al-2", "Beta", Some("lib-b")),
                track("s1", "t3", "al-3", "Gamma", Some("lib-c")),
            ])
            .unwrap();
        seed_album(&store, "s1", "al-1", "Alpha", 1);
        seed_album(&store, "s1", "al-2", "Beta", 1);
        seed_album(&store, "s1", "al-3", "Gamma", 1);

        let mut scoped = req("s1", 50, 0);
        scoped.library_scope_ids = Some(vec!["lib-a".into(), "lib-b".into()]);
        let resp = list_albums(&store, &scoped).unwrap();
        assert_eq!(resp.albums.len(), 2);
        assert_eq!(resp.albums[0].id, "al-1");
        assert_eq!(resp.albums[1].id, "al-2");
    }

    #[test]
    fn multi_library_scope_includes_track_only_albums() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "al-1", "Alpha", Some("lib-a")),
                track("s1", "t2", "al-2", "Zulu", Some("lib-b")),
            ])
            .unwrap();
        seed_album(&store, "s1", "al-1", "Alpha", 1);

        let mut scoped = req("s1", 50, 0);
        scoped.library_scope_ids = Some(vec!["lib-a".into(), "lib-b".into()]);
        let resp = list_albums(&store, &scoped).unwrap();
        assert_eq!(resp.albums.len(), 2);
        assert_eq!(resp.albums[0].id, "al-1");
        assert_eq!(resp.albums[1].id, "al-2");
    }
}
