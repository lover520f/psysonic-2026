//! Cluster-scope advanced search: run per-server advanced search, then merge
//! winners by cluster identity keys with server-priority precedence.

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::types::Value as SqlValue;

use crate::advanced_search::run_advanced_search;
use crate::dto::{
    LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse, LibraryAlbumDto, LibraryArtistDto,
    LibraryClusterAdvancedSearchRequest, LibrarySearchTotals, LibraryTrackDto,
};
use crate::search::PAGE_LIMIT_MAX;
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;

pub fn run_cluster_advanced_search(
    store: &LibraryStore,
    req: LibraryClusterAdvancedSearchRequest,
) -> Result<LibraryAdvancedSearchResponse, String> {
    if req.servers_ordered.is_empty() {
        return Ok(empty_response(req.skip_totals));
    }

    let page_limit = req.limit.clamp(1, PAGE_LIMIT_MAX);
    let page_offset = req.offset as usize;
    let per_server_limit = req
        .limit
        .saturating_add(req.offset)
        .clamp(1, PAGE_LIMIT_MAX);

    let mut all_tracks: Vec<LibraryTrackDto> = Vec::new();
    let mut all_albums: Vec<LibraryAlbumDto> = Vec::new();
    let mut all_artists: Vec<LibraryArtistDto> = Vec::new();
    let mut applied_filters = BTreeSet::new();

    for server_id in &req.servers_ordered {
        let server_req = LibraryAdvancedSearchRequest {
            server_id: server_id.clone(),
            library_scope: req.library_scopes.get(server_id).cloned(),
            query: req.query.clone(),
            entity_types: req.entity_types.clone(),
            filters: req.filters.clone(),
            starred_only: req.starred_only,
            restrict_album_ids: req.restrict_album_ids.clone(),
            query_album_title_only: req.query_album_title_only,
            sort: req.sort.clone(),
            limit: per_server_limit,
            offset: 0,
            skip_totals: true,
        };
        let resp = run_advanced_search(store, &server_req)?;
        all_tracks.extend(resp.tracks);
        all_albums.extend(resp.albums);
        all_artists.extend(resp.artists);
        applied_filters.extend(resp.applied_filters);
    }

    let merged_tracks = merge_tracks_by_cluster_key(store, all_tracks)?;
    let merged_albums = merge_albums_by_album_key(store, all_albums)?;
    let merged_artists = merge_artists_by_artist_key(store, all_artists)?;

    let totals = if req.skip_totals {
        LibrarySearchTotals::default()
    } else {
        LibrarySearchTotals {
            artists: merged_artists.len() as u32,
            albums: merged_albums.len() as u32,
            tracks: merged_tracks.len() as u32,
        }
    };

    Ok(LibraryAdvancedSearchResponse {
        artists: merged_artists
            .into_iter()
            .skip(page_offset)
            .take(page_limit as usize)
            .collect(),
        albums: merged_albums
            .into_iter()
            .skip(page_offset)
            .take(page_limit as usize)
            .collect(),
        tracks: merged_tracks
            .into_iter()
            .skip(page_offset)
            .take(page_limit as usize)
            .collect(),
        totals,
        applied_filters: applied_filters.into_iter().collect(),
        source: "local".to_string(),
    })
}

fn empty_response(skip_totals: bool) -> LibraryAdvancedSearchResponse {
    LibraryAdvancedSearchResponse {
        artists: Vec::new(),
        albums: Vec::new(),
        tracks: Vec::new(),
        totals: if skip_totals {
            LibrarySearchTotals::default()
        } else {
            LibrarySearchTotals {
                artists: 0,
                albums: 0,
                tracks: 0,
            }
        },
        applied_filters: Vec::new(),
        source: "local".to_string(),
    }
}

fn merge_tracks_by_cluster_key(
    store: &LibraryStore,
    tracks: Vec<LibraryTrackDto>,
) -> Result<Vec<LibraryTrackDto>, String> {
    let refs: Vec<(String, String)> = tracks
        .iter()
        .map(|t| (t.server_id.clone(), t.id.clone()))
        .collect();
    let key_map = lookup_track_cluster_keys(store, &refs)?;

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for track in tracks {
        let key = key_map
            .get(&(track.server_id.clone(), track.id.clone()))
            .and_then(|v| v.clone())
            .unwrap_or_else(|| format!("solo:{}:{}", track.server_id, track.id));
        if seen.insert(key) {
            out.push(track);
        }
    }
    Ok(out)
}

fn merge_albums_by_album_key(
    store: &LibraryStore,
    albums: Vec<LibraryAlbumDto>,
) -> Result<Vec<LibraryAlbumDto>, String> {
    let refs: Vec<(String, String)> = albums
        .iter()
        .map(|a| (a.server_id.clone(), a.id.clone()))
        .collect();
    let key_map = lookup_album_keys(store, &refs)?;

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for album in albums {
        let key = key_map
            .get(&(album.server_id.clone(), album.id.clone()))
            .and_then(|v| v.clone())
            .unwrap_or_else(|| format!("solo:{}:{}", album.server_id, album.id));
        if seen.insert(key) {
            out.push(album);
        }
    }
    Ok(out)
}

fn merge_artists_by_artist_key(
    store: &LibraryStore,
    artists: Vec<LibraryArtistDto>,
) -> Result<Vec<LibraryArtistDto>, String> {
    let refs: Vec<(String, String)> = artists
        .iter()
        .map(|a| (a.server_id.clone(), a.id.clone()))
        .collect();
    let key_map = lookup_artist_keys(store, &refs)?;

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for artist in artists {
        let key = key_map
            .get(&(artist.server_id.clone(), artist.id.clone()))
            .and_then(|v| v.clone())
            .unwrap_or_else(|| format!("solo:{}:{}", artist.server_id, artist.id));
        if seen.insert(key) {
            out.push(artist);
        }
    }
    Ok(out)
}

fn lookup_track_cluster_keys(
    store: &LibraryStore,
    refs: &[(String, String)],
) -> Result<HashMap<(String, String), Option<String>>, String> {
    lookup_keys_with_values(
        store,
        refs,
        &format!(
            "SELECT w.server_id, w.entity_id, k.cluster_key
             FROM wanted w
             LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
               ON k.server_id = w.server_id AND k.track_id = w.entity_id"
        ),
    )
}

fn lookup_album_keys(
    store: &LibraryStore,
    refs: &[(String, String)],
) -> Result<HashMap<(String, String), Option<String>>, String> {
    lookup_keys_with_values(
        store,
        refs,
        &format!(
            "SELECT w.server_id, w.entity_id, MIN(k.album_key)
             FROM wanted w
             LEFT JOIN track t
               ON t.server_id = w.server_id AND t.album_id = w.entity_id AND t.deleted = 0
             LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
               ON k.server_id = t.server_id AND k.track_id = t.id
             GROUP BY w.server_id, w.entity_id"
        ),
    )
}

fn lookup_artist_keys(
    store: &LibraryStore,
    refs: &[(String, String)],
) -> Result<HashMap<(String, String), Option<String>>, String> {
    lookup_keys_with_values(
        store,
        refs,
        &format!(
            "SELECT w.server_id, w.entity_id, MIN(k.artist_key)
             FROM wanted w
             LEFT JOIN track t
               ON t.server_id = w.server_id
              AND COALESCE(NULLIF(t.artist_id, ''), t.artist) = w.entity_id
              AND t.deleted = 0
             LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
               ON k.server_id = t.server_id AND k.track_id = t.id
             GROUP BY w.server_id, w.entity_id"
        ),
    )
}

fn lookup_keys_with_values(
    store: &LibraryStore,
    refs: &[(String, String)],
    query_sql: &str,
) -> Result<HashMap<(String, String), Option<String>>, String> {
    if refs.is_empty() {
        return Ok(HashMap::new());
    }

    let values_sql = std::iter::repeat_n("(?, ?)", refs.len()).collect::<Vec<_>>().join(", ");
    let sql = format!("WITH wanted(server_id, entity_id) AS (VALUES {values_sql}) {query_sql}");

    let mut bind: Vec<SqlValue> = Vec::with_capacity(refs.len() * 2);
    for (server_id, entity_id) in refs {
        bind.push(SqlValue::Text(server_id.clone()));
        bind.push(SqlValue::Text(entity_id.clone()));
    }

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(rusqlite::params_from_iter(bind.iter()))?;
        let mut out = HashMap::new();
        while let Some(row) = rows.next()? {
            let server_id: String = row.get(0)?;
            let entity_id: String = row.get(1)?;
            let key: Option<String> = row.get(2)?;
            out.insert((server_id, entity_id), key);
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use crate::filter::EntityKind;
    use crate::repos::{TrackRepository, TrackRow};
    use crate::server_cluster::rebuild::rebuild_all_cluster_keys;

    use super::*;

    fn track(server: &str, id: &str, artist: &str, artist_id: &str, album: &str, album_id: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: "Song".into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: Some(artist_id.into()),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: Some(artist.into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: Some(2024),
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
    fn merges_tracks_by_cluster_key_with_priority() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Band", "art-1", "LP", "alb-1"),
                track("s2", "t2", "Band", "art-2", "LP", "alb-2"),
            ])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        let resp = run_cluster_advanced_search(
            &store,
            LibraryClusterAdvancedSearchRequest {
                servers_ordered: vec!["s1".into(), "s2".into()],
                query: None,
                entity_types: vec![EntityKind::Track],
                filters: Vec::new(),
                starred_only: None,
                restrict_album_ids: None,
                query_album_title_only: None,
                sort: Vec::new(),
                limit: 50,
                offset: 0,
                skip_totals: false,
                library_scopes: HashMap::new(),
            },
        )
        .unwrap();

        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].server_id, "s1");
        assert_eq!(resp.totals.tracks, 1);
        assert_eq!(resp.totals.albums, 0);
        assert_eq!(resp.totals.artists, 0);
    }

    #[test]
    fn applies_offset_after_merge() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Band A", "art-a1", "LP A", "alb-a1"),
                track("s2", "t2", "Band A", "art-a2", "LP A", "alb-a2"),
                track("s1", "t3", "Band B", "art-b1", "LP B", "alb-b1"),
            ])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        let resp = run_cluster_advanced_search(
            &store,
            LibraryClusterAdvancedSearchRequest {
                servers_ordered: vec!["s1".into(), "s2".into()],
                query: None,
                entity_types: vec![EntityKind::Track],
                filters: Vec::new(),
                starred_only: None,
                restrict_album_ids: None,
                query_album_title_only: None,
                sort: Vec::new(),
                limit: 1,
                offset: 1,
                skip_totals: false,
                library_scopes: HashMap::new(),
            },
        )
        .unwrap();

        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.totals.tracks, 2);
    }
}
