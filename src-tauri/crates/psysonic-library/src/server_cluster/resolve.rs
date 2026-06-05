//! Resolve cluster candidates for playback / writes (spec §5–6).

use rusqlite::types::Value as SqlValue;
use rusqlite::OptionalExtension;

use crate::dto::LibraryClusterCandidateDto;
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;
use super::merge::duration_partitions;
use super::priority::priority_case_sql;

/// All `(server_id, track_id)` rows sharing a `cluster_key`, ordered by priority.
pub fn resolve_candidates_by_cluster_key(
    store: &LibraryStore,
    servers_ordered: &[String],
    cluster_key: &str,
) -> Result<Vec<LibraryClusterCandidateDto>, String> {
    if servers_ordered.is_empty() || cluster_key.is_empty() {
        return Ok(Vec::new());
    }
    let (priority_sql, mut priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let in_placeholders = vec!["?"; servers_ordered.len()].join(", ");
    let mut in_params: Vec<SqlValue> = servers_ordered
        .iter()
        .map(|s| SqlValue::Text(s.clone()))
        .collect();

    let sql = format!(
        "SELECT t.server_id, t.id, COALESCE(k.duration_sec, t.duration_sec), ({priority_sql})
           FROM {ATTACH_ALIAS}.track_cluster_key k
           JOIN track t ON t.server_id = k.server_id AND t.id = k.track_id
          WHERE k.cluster_key = ? AND t.deleted = 0 AND t.server_id IN ({in_placeholders})
          ORDER BY 4, t.server_id, t.id"
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.append(&mut priority_params);
    params.push(SqlValue::Text(cluster_key.to_string()));
    params.append(&mut in_params);

    let rows: Vec<(String, String, i64, u32)> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let collected = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? as u32))
        })?;
        collected.collect::<rusqlite::Result<Vec<_>>>()
    })?;

    let with_rank = rows;

    let partitions = duration_partitions(cluster_key, &with_rank);
    let winner = partitions.first();
    Ok(with_rank
        .into_iter()
        .map(|(server_id, track_id, duration_sec, priority_rank)| {
            let is_winner = winner
                .map(|(_, ws, wt)| ws == &server_id && wt == &track_id)
                .unwrap_or(false);
            LibraryClusterCandidateDto {
                server_id,
                track_id,
                duration_sec,
                priority_rank,
                is_winner,
            }
        })
        .collect())
}

/// Resolve `cluster_key` from a seed track, then return candidates.
pub fn resolve_candidates_for_track(
    store: &LibraryStore,
    servers_ordered: &[String],
    server_id: &str,
    track_id: &str,
) -> Result<Vec<LibraryClusterCandidateDto>, String> {
    let cluster_key: Option<String> = store.with_read_conn(|conn| {
        conn.query_row(
            &format!(
                "SELECT cluster_key FROM {ATTACH_ALIAS}.track_cluster_key \
                 WHERE server_id = ?1 AND track_id = ?2"
            ),
            rusqlite::params![server_id, track_id],
            |r| r.get(0),
        )
        .optional()
    })?;

    let Some(cluster_key) = cluster_key else {
        return Ok(vec![LibraryClusterCandidateDto {
            server_id: server_id.to_string(),
            track_id: track_id.to_string(),
            duration_sec: track_duration(store, server_id, track_id)?,
            priority_rank: servers_ordered
                .iter()
                .position(|s| s == server_id)
                .unwrap_or(9999) as u32,
            is_winner: true,
        }]);
    };

    resolve_candidates_by_cluster_key(store, servers_ordered, &cluster_key)
}

fn track_duration(store: &LibraryStore, server_id: &str, track_id: &str) -> Result<i64, String> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT duration_sec FROM track WHERE server_id = ?1 AND id = ?2 AND deleted = 0",
                rusqlite::params![server_id, track_id],
                |r| r.get(0),
            )
        })
        .map_err(|e| e.to_string())
}

/// Lookup cluster key for a track (for search/seed mapping).
pub fn cluster_key_for_track(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
) -> Result<Option<String>, String> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT cluster_key FROM {ATTACH_ALIAS}.track_cluster_key \
                     WHERE server_id = ?1 AND track_id = ?2"
                ),
                rusqlite::params![server_id, track_id],
                |r| r.get(0),
            )
            .optional()
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use crate::server_cluster::rebuild::rebuild_all_cluster_keys;

    fn tr(server: &str, id: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: "Song".into(),
            title_sort: None,
            artist: Some("Band".into()),
            artist_id: None,
            album: "LP".into(),
            album_id: None,
            album_artist: Some("Band".into()),
            duration_sec: 180,
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
    fn resolve_orders_by_priority() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[tr("s1", "t1"), tr("s2", "t2")])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();
        let key = cluster_key_for_track(&store, "s1", "t1").unwrap().unwrap();
        let cands = resolve_candidates_by_cluster_key(&store, &["s1".into(), "s2".into()], &key).unwrap();
        assert_eq!(cands.len(), 2);
        assert!(cands[0].is_winner);
        assert_eq!(cands[0].server_id, "s1");
    }
}
