//! Cluster-mode cross-server search — dedup by `cluster_key` + priority (spec §5).

use std::collections::HashSet;

use rusqlite::types::Value as SqlValue;

use crate::dto::{LibraryCrossServerSearchResponse, LibraryTrackDto};
use crate::repos;
use crate::search::{aliased_track_columns, fts_query, like_contains, PAGE_LIMIT_MAX};
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;
use super::merge::solo_partition_key;
use super::priority::{in_list_sql, priority_case_sql};

const FUZZY_PER_SERVER_CAP: usize = 20;

/// FTS union over ordered servers; dedup by `cluster_key` (not canonical id).
pub fn run_cluster_search(
    store: &LibraryStore,
    query: &str,
    limit: u32,
    servers_ordered: &[String],
) -> Result<LibraryCrossServerSearchResponse, String> {
    let limit = limit.clamp(1, PAGE_LIMIT_MAX);
    if servers_ordered.is_empty() {
        return Ok(LibraryCrossServerSearchResponse::default());
    }
    let Some(fts) = fts_query(query) else {
        return Ok(LibraryCrossServerSearchResponse::default());
    };

    let (in_placeholders, mut in_params) = in_list_sql(servers_ordered);
    let (priority_sql, mut priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let cols = aliased_track_columns("t");
    let canonical_idx = repos::track_columns().split(',').count();

    let sql = format!(
        "SELECT {cols}, k.cluster_key, ({priority_sql}) AS priority_rank \
         FROM track_fts f \
         JOIN track t ON t.rowid = f.rowid \
         LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k \
           ON k.server_id = t.server_id AND k.track_id = t.id \
         WHERE track_fts MATCH ? AND t.deleted = 0 AND t.server_id IN ({in_placeholders}) \
         ORDER BY bm25(track_fts) LIMIT ?"
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.push(SqlValue::Text(fts));
    params.append(&mut priority_params);
    params.append(&mut in_params);
    params.push(SqlValue::Integer((limit as i64).saturating_mul(4)));

    let rows: Vec<(LibraryTrackDto, Option<String>, u32)> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let collected = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let track = repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))?;
            let cluster_key: Option<String> = r.get(canonical_idx)?;
            let rank: i64 = r.get(canonical_idx + 1)?;
            Ok((track, cluster_key, rank as u32))
        })?;
        collected.collect::<rusqlite::Result<Vec<_>>>()
    })?;

    let mut best_by_key: std::collections::HashMap<String, (LibraryTrackDto, u32)> =
        std::collections::HashMap::new();
    for (track, cluster_key, priority_rank) in rows {
        let dedup_key = cluster_key
            .clone()
            .unwrap_or_else(|| solo_partition_key(&track.server_id, &track.id));
        match best_by_key.get(&dedup_key) {
            Some((_, best_rank)) if *best_rank <= priority_rank => {}
            _ => {
                best_by_key.insert(dedup_key, (track, priority_rank));
            }
        }
    }

    let mut hits: Vec<LibraryTrackDto> = best_by_key.into_values().map(|(t, _)| t).collect();
    hits.truncate(limit as usize);

    let hit_keys: HashSet<(String, String)> = hits
        .iter()
        .map(|t| (t.server_id.clone(), t.id.clone()))
        .collect();
    let fuzzy = fuzzy_cluster_matches(
        store,
        servers_ordered,
        query.trim(),
        &hit_keys,
        limit as usize,
    )?;

    Ok(LibraryCrossServerSearchResponse {
        hits,
        fuzzy,
        servers_searched: servers_ordered.to_vec(),
    })
}

fn fuzzy_cluster_matches(
    store: &LibraryStore,
    targets: &[String],
    query: &str,
    hit_keys: &HashSet<(String, String)>,
    overall_cap: usize,
) -> Result<Vec<LibraryTrackDto>, String> {
    let like = like_contains(query);
    let cols = aliased_track_columns("t");
    let key_idx = repos::track_columns().split(',').count();
    let sql = format!(
        "SELECT {cols}, k.cluster_key \
         FROM track t \
         LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k \
           ON k.server_id = t.server_id AND k.track_id = t.id \
         WHERE t.server_id = ? AND t.deleted = 0 AND t.title LIKE ? ESCAPE '\\' \
         ORDER BY t.title COLLATE NOCASE ASC LIMIT ?"
    );

    let mut out: Vec<LibraryTrackDto> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    for server in targets {
        if out.len() >= overall_cap {
            break;
        }
        let bound = [
            SqlValue::Text(server.clone()),
            SqlValue::Text(like.clone()),
            SqlValue::Integer(FUZZY_PER_SERVER_CAP as i64),
        ];
        let rows: Vec<(LibraryTrackDto, Option<String>)> = store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let collected = stmt.query_map(rusqlite::params_from_iter(bound.iter()), |r| {
                let track = repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))?;
                let cluster_key: Option<String> = r.get(key_idx)?;
                Ok((track, cluster_key))
            })?;
            collected.collect::<rusqlite::Result<Vec<_>>>()
        })?;

        for (track, cluster_key) in rows {
            if out.len() >= overall_cap {
                break;
            }
            if hit_keys.contains(&(track.server_id.clone(), track.id.clone())) {
                continue;
            }
            let dedup_key = cluster_key
                .clone()
                .unwrap_or_else(|| solo_partition_key(&track.server_id, &track.id));
            if !seen_keys.insert(dedup_key) {
                continue;
            }
            out.push(track);
        }
    }
    Ok(out)
}
