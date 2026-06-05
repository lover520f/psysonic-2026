//! Cluster-scoped player statistics — aggregate `play_session` across members (spec §4 Tier 2).

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;

use crate::dto::{
    PlaySessionDayDetailDto, PlaySessionDayTotalsDto, PlaySessionDayTrackDto, PlaySessionHeatmapDayDto,
    PlaySessionMostPlayedDto, PlaySessionRecentDayDto, PlaySessionYearSummaryDto,
};
use crate::repos;
use crate::search::aliased_track_columns;
use crate::store::LibraryStore;

use super::db::ATTACH_ALIAS;
use super::merge::DURATION_TOLERANCE_SEC;
use super::priority::in_list_sql;
use super::priority::priority_case_sql;

const RECENT_DAYS_LIMIT_MAX: u32 = 90;
const MOST_PLAYED_LIMIT_MAX: u32 = 200;

#[derive(Default)]
struct DayAgg {
    total_listened_sec: f64,
    track_play_count: u32,
    full_count: u32,
    partial_count: u32,
    plays: Vec<(i64, f64)>,
}

fn server_filter_sql(servers_ordered: &[String]) -> Result<(String, Vec<SqlValue>), String> {
    if servers_ordered.is_empty() {
        return Err("servers_ordered required".into());
    }
    let (placeholders, params) = in_list_sql(servers_ordered);
    Ok((format!("ps.server_id IN ({placeholders})"), params))
}

fn unique_track_expr() -> &'static str {
    "COALESCE(k.cluster_key, ps.server_id || ':' || ps.track_id)"
}

fn count_listening_sessions(plays: &[(i64, f64)]) -> u32 {
    const GAP_MS: i64 = 30 * 60 * 1000;
    if plays.is_empty() {
        return 0;
    }
    let mut sorted = plays.to_vec();
    sorted.sort_by_key(|p| p.0);
    let mut sessions = 1u32;
    let mut prev_end = sorted[0].0 + (sorted[0].1 * 1000.0) as i64;
    for (started, listened) in sorted.iter().skip(1) {
        if *started - prev_end > GAP_MS {
            sessions += 1;
        }
        let end = *started + (*listened * 1000.0) as i64;
        prev_end = prev_end.max(end);
    }
    sessions
}

fn validate_date_iso(date_iso: &str) -> Result<(), String> {
    if date_iso.len() != 10 || date_iso.as_bytes()[4] != b'-' || date_iso.as_bytes()[7] != b'-' {
        return Err("dateIso must be YYYY-MM-DD".into());
    }
    let year: i32 = date_iso[0..4]
        .parse()
        .map_err(|_| "dateIso must be YYYY-MM-DD".to_string())?;
    let month: u32 = date_iso[5..7]
        .parse()
        .map_err(|_| "dateIso must be YYYY-MM-DD".to_string())?;
    let day: u32 = date_iso[8..10]
        .parse()
        .map_err(|_| "dateIso must be YYYY-MM-DD".to_string())?;
    if year < 1970 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err("dateIso must be YYYY-MM-DD".into());
    }
    Ok(())
}

pub fn cluster_year_summary(
    store: &LibraryStore,
    servers_ordered: &[String],
    year: i32,
) -> Result<PlaySessionYearSummaryDto, String> {
    let (server_sql, mut params) = server_filter_sql(servers_ordered)?;
    let year_str = year.to_string();
    let unique = unique_track_expr();

    store
        .with_read_conn(|conn| {
            let sql = format!(
                "SELECT \
                   COALESCE(SUM(ps.listened_sec), 0.0), \
                   COUNT(*), \
                   COUNT(DISTINCT {unique}), \
                   COUNT(DISTINCT date(ps.started_at_ms / 1000, 'unixepoch', 'localtime')), \
                   COALESCE(SUM(CASE WHEN ps.completion = 'full' THEN 1 ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN ps.completion = 'partial' THEN 1 ELSE 0 END), 0) \
                 FROM play_session ps \
                 LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k \
                   ON k.server_id = ps.server_id AND k.track_id = ps.track_id \
                 WHERE {server_sql} \
                   AND strftime('%Y', ps.started_at_ms / 1000, 'unixepoch', 'localtime') = ?",
            );
            params.push(SqlValue::Text(year_str.clone()));

            let totals = conn.query_row(
                &sql,
                rusqlite::params_from_iter(params.iter()),
                |row| {
                    Ok((
                        row.get::<_, f64>(0)?,
                        row.get::<_, i64>(1)? as u32,
                        row.get::<_, i64>(2)? as u32,
                        row.get::<_, i64>(3)? as u32,
                        row.get::<_, i64>(4)? as u32,
                        row.get::<_, i64>(5)? as u32,
                    ))
                },
            )?;

            let plays_sql = format!(
                "SELECT ps.started_at_ms, ps.listened_sec \
                 FROM play_session ps \
                 WHERE {server_sql} \
                   AND strftime('%Y', ps.started_at_ms / 1000, 'unixepoch', 'localtime') = ? \
                 ORDER BY ps.started_at_ms ASC",
            );
            let mut play_params = params[..params.len() - 1].to_vec();
            play_params.push(SqlValue::Text(year_str));

            let mut stmt = conn.prepare(&plays_sql)?;
            let plays = stmt
                .query_map(rusqlite::params_from_iter(play_params.iter()), |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let (
                total_listened_sec,
                track_play_count,
                unique_track_count,
                listening_day_count,
                full_count,
                partial_count,
            ) = totals;
            Ok(PlaySessionYearSummaryDto {
                total_listened_sec,
                session_count: count_listening_sessions(&plays),
                track_play_count,
                unique_track_count,
                listening_day_count,
                full_count,
                partial_count,
            })
        })
        .map_err(|e| e.to_string())
}

pub fn cluster_heatmap(
    store: &LibraryStore,
    servers_ordered: &[String],
    year: i32,
) -> Result<Vec<PlaySessionHeatmapDayDto>, String> {
    let (server_sql, mut params) = server_filter_sql(servers_ordered)?;
    params.push(SqlValue::Text(year.to_string()));

    store
        .with_read_conn(|conn| {
            let sql = format!(
                "SELECT \
                   date(ps.started_at_ms / 1000, 'unixepoch', 'localtime') AS d, \
                   COUNT(*) AS n \
                 FROM play_session ps \
                 WHERE {server_sql} \
                   AND strftime('%Y', ps.started_at_ms / 1000, 'unixepoch', 'localtime') = ? \
                 GROUP BY d \
                 ORDER BY d ASC",
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok(PlaySessionHeatmapDayDto {
                        date: row.get(0)?,
                        track_play_count: row.get::<_, i64>(1)? as u32,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .map_err(|e| e.to_string())
}

pub fn cluster_day_detail(
    store: &LibraryStore,
    servers_ordered: &[String],
    date_iso: &str,
) -> Result<PlaySessionDayDetailDto, String> {
    validate_date_iso(date_iso)?;
    let (server_sql, mut params) = server_filter_sql(servers_ordered)?;
    params.push(SqlValue::Text(date_iso.to_string()));

    store
        .with_read_conn(|conn| {
            let totals_sql = format!(
                "SELECT \
                   COALESCE(SUM(ps.listened_sec), 0.0), \
                   COUNT(*), \
                   COALESCE(SUM(CASE WHEN ps.completion = 'full' THEN 1 ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN ps.completion = 'partial' THEN 1 ELSE 0 END), 0) \
                 FROM play_session ps \
                 WHERE {server_sql} \
                   AND date(ps.started_at_ms / 1000, 'unixepoch', 'localtime') = ?",
            );
            let (total_listened_sec, track_play_count, full_count, partial_count) = conn.query_row(
                &totals_sql,
                rusqlite::params_from_iter(params.iter()),
                |row| {
                    Ok((
                        row.get::<_, f64>(0)?,
                        row.get::<_, i64>(1)? as u32,
                        row.get::<_, i64>(2)? as u32,
                        row.get::<_, i64>(3)? as u32,
                    ))
                },
            )?;

            let (in_placeholders, mut in_params) = in_list_sql(servers_ordered);
            let (priority_sql, mut priority_params) = priority_case_sql("t.server_id", servers_ordered);
            let cols = aliased_track_columns("t");
            let rows_sql = format!(
                "WITH sessions AS (
                   SELECT
                     ps.started_at_ms,
                     ps.listened_sec,
                     ps.completion,
                     COALESCE(k.cluster_key, 'solo:' || ps.server_id || ':' || ps.track_id) AS merge_key
                   FROM play_session ps
                   LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
                     ON k.server_id = ps.server_id AND k.track_id = ps.track_id
                   WHERE {server_sql}
                     AND date(ps.started_at_ms / 1000, 'unixepoch', 'localtime') = ?
                 ),
                 candidates AS (
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
                 winners AS (
                   SELECT merge_key, tid,
                     ROW_NUMBER() OVER (PARTITION BY merge_key ORDER BY priority_rank) AS rn
                   FROM partitioned
                 )
                 SELECT {cols}, s.listened_sec, s.completion, s.started_at_ms
                   FROM sessions s
                   JOIN winners w ON w.merge_key = s.merge_key AND w.rn = 1
                   JOIN track t ON t.rowid = w.tid
                  ORDER BY s.started_at_ms DESC",
                tol = DURATION_TOLERANCE_SEC,
            );

            let mut rows_params = params.clone();
            rows_params.append(&mut priority_params);
            rows_params.append(&mut in_params);

            let track_col_count = repos::track_columns().split(',').count();
            let mut stmt = conn.prepare(&rows_sql)?;
            let tracks = stmt
                .query_map(rusqlite::params_from_iter(rows_params.iter()), |row| {
                    let track = repos::row_to_track_row(row).map(|r| crate::dto::LibraryTrackDto::from_row(&r))?;
                    Ok(PlaySessionDayTrackDto {
                        server_id: track.server_id,
                        track_id: track.id,
                        title: track.title,
                        artist: track.artist,
                        listened_sec: row.get(track_col_count)?,
                        completion: row.get(track_col_count + 1)?,
                        started_at_ms: row.get(track_col_count + 2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let plays: Vec<(i64, f64)> = tracks
                .iter()
                .map(|t| (t.started_at_ms, t.listened_sec))
                .collect();
            Ok(PlaySessionDayDetailDto {
                totals: PlaySessionDayTotalsDto {
                    total_listened_sec,
                    session_count: count_listening_sessions(&plays),
                    track_play_count,
                    full_count,
                    partial_count,
                },
                tracks,
            })
        })
        .map_err(|e| e.to_string())
}

pub fn cluster_recent_days(
    store: &LibraryStore,
    servers_ordered: &[String],
    limit: u32,
) -> Result<Vec<PlaySessionRecentDayDto>, String> {
    let limit = limit.clamp(1, RECENT_DAYS_LIMIT_MAX);
    let (server_sql, params) = server_filter_sql(servers_ordered)?;

    store
        .with_read_conn(|conn| {
            let sql = format!(
                "SELECT
                   date(ps.started_at_ms / 1000, 'unixepoch', 'localtime') AS d,
                   ps.started_at_ms,
                   ps.listened_sec,
                   ps.completion
                 FROM play_session ps
                 WHERE {server_sql}
                 ORDER BY d DESC, ps.started_at_ms ASC",
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?;

            let mut by_day: HashMap<String, DayAgg> = HashMap::new();
            for row in rows {
                let (date, started_at_ms, listened_sec, completion) = row?;
                let agg = by_day.entry(date).or_default();
                agg.total_listened_sec += listened_sec;
                agg.track_play_count += 1;
                if completion == "full" {
                    agg.full_count += 1;
                } else {
                    agg.partial_count += 1;
                }
                agg.plays.push((started_at_ms, listened_sec));
            }

            let mut out: Vec<PlaySessionRecentDayDto> = by_day
                .into_iter()
                .map(|(date, agg)| PlaySessionRecentDayDto {
                    date,
                    total_listened_sec: agg.total_listened_sec,
                    session_count: count_listening_sessions(&agg.plays),
                    track_play_count: agg.track_play_count,
                    full_count: agg.full_count,
                    partial_count: agg.partial_count,
                })
                .collect();
            out.sort_by(|a, b| b.date.cmp(&a.date));
            out.truncate(limit as usize);
            Ok(out)
        })
        .map_err(|e| e.to_string())
}

pub fn cluster_most_played(
    store: &LibraryStore,
    servers_ordered: &[String],
    limit: u32,
) -> Result<Vec<PlaySessionMostPlayedDto>, String> {
    let limit = limit.clamp(1, MOST_PLAYED_LIMIT_MAX);
    let (server_sql, mut stats_params) = server_filter_sql(servers_ordered)?;
    let (in_placeholders, mut in_params) = in_list_sql(servers_ordered);
    let (priority_sql, mut priority_params) = priority_case_sql("t.server_id", servers_ordered);
    let cols = aliased_track_columns("t");
    let col_count = repos::track_columns().split(',').count();

    let sql = format!(
        "WITH session_counts AS (
           SELECT
             COALESCE(k.cluster_key, 'solo:' || ps.server_id || ':' || ps.track_id) AS merge_key,
             COUNT(*) AS track_play_count,
             COALESCE(SUM(ps.listened_sec), 0.0) AS total_listened_sec
           FROM play_session ps
           LEFT JOIN {ATTACH_ALIAS}.track_cluster_key k
             ON k.server_id = ps.server_id AND k.track_id = ps.track_id
           WHERE {server_sql}
           GROUP BY merge_key
         ),
         candidates AS (
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
         winners AS (
           SELECT merge_key, tid,
             ROW_NUMBER() OVER (PARTITION BY merge_key ORDER BY priority_rank) AS rn
           FROM partitioned
         )
         SELECT {cols}, sc.track_play_count, sc.total_listened_sec
           FROM session_counts sc
           JOIN winners w ON w.merge_key = sc.merge_key AND w.rn = 1
           JOIN track t ON t.rowid = w.tid
          ORDER BY sc.track_play_count DESC, sc.total_listened_sec DESC, t.title COLLATE NOCASE ASC
          LIMIT ?",
        tol = DURATION_TOLERANCE_SEC,
    );

    let mut params: Vec<SqlValue> = Vec::new();
    params.append(&mut stats_params);
    params.append(&mut priority_params);
    params.append(&mut in_params);
    params.push(SqlValue::Integer(limit as i64));

    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                let track =
                    repos::row_to_track_row(row).map(|r| crate::dto::LibraryTrackDto::from_row(&r))?;
                Ok(PlaySessionMostPlayedDto {
                    track,
                    track_play_count: row.get::<_, i64>(col_count)? as u32,
                    total_listened_sec: row.get(col_count + 1)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use crate::server_cluster::rebuild::rebuild_all_cluster_keys;

    fn track(server: &str, id: &str, title: &str, artist: &str, album: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: Some(format!("art-{server}")),
            album: album.into(),
            album_id: Some(format!("alb-{server}")),
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
    fn day_detail_merges_track_identity_to_cluster_winner() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Song", "Band", "LP"),
                track("s2", "t2", "Song", "Band", "LP"),
            ])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        store
            .with_conn_mut("test", |conn| {
                conn.execute(
                    "INSERT INTO play_session (server_id, track_id, started_at_ms, listened_sec, position_max_sec, completion, end_reason)
                     VALUES (?1, ?2, ?3, 120.0, 120.0, 'full', 'ended')",
                    rusqlite::params!["s2", "t2", 1_000i64],
                )?;
                Ok(())
            })
            .unwrap();

        let detail = cluster_day_detail(&store, &["s1".into(), "s2".into()], "1970-01-01").unwrap();
        assert_eq!(detail.tracks.len(), 1);
        assert_eq!(detail.tracks[0].server_id, "s1");
        assert_eq!(detail.tracks[0].track_id, "t1");
        assert_eq!(detail.totals.track_play_count, 1);
    }

    #[test]
    fn most_played_aggregates_cluster_members() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Song", "Band", "LP"),
                track("s2", "t2", "Song", "Band", "LP"),
            ])
            .unwrap();
        rebuild_all_cluster_keys(&store).unwrap();

        store
            .with_conn_mut("test", |conn| {
                conn.execute(
                    "INSERT INTO play_session (server_id, track_id, started_at_ms, listened_sec, position_max_sec, completion, end_reason)
                     VALUES
                     ('s1', 't1', 1700000000000, 60.0, 60.0, 'partial', 'ended'),
                     ('s2', 't2', 1700000100000, 90.0, 90.0, 'full', 'ended')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let rows = cluster_most_played(&store, &["s1".into(), "s2".into()], 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].track.server_id, "s1");
        assert_eq!(rows[0].track_play_count, 2);
    }
}
