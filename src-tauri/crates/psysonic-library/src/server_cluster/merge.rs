//! Duration guard and partition keys for cluster merge (spec §2.3).

pub const DURATION_TOLERANCE_SEC: i64 = 5;

/// Roll up per-track candidates to one row per `(server_id, album_id)` before
/// partitioning by `album_key` (spec §4 — album lists dedup by `album_key`).
pub const ALBUM_ROLLUP_AND_PARTITION_CTE: &str = "
  album_rollup AS (
    SELECT
      c.server_id,
      c.album_id,
      MIN(c.tid) AS tid,
      MIN(c.priority_rank) AS priority_rank,
      MAX(c.album_key) AS album_key
    FROM candidates c
    GROUP BY c.server_id, c.album_id
  ),
  partitioned AS (
    SELECT
      r.tid,
      CASE
        WHEN r.album_key IS NOT NULL THEN r.album_key
        ELSE 'solo:' || r.server_id || ':' || r.album_id
      END AS merge_key,
      r.priority_rank
    FROM album_rollup r
  ),
";

/// Synthetic partition for tracks without a `cluster_key` row (never merged).
pub fn solo_partition_key(server_id: &str, track_id: &str) -> String {
    format!("solo:{server_id}:{track_id}")
}

/// Within one `cluster_key` group, split rows that fall outside ± tolerance of
/// the reference (priority-1 available candidate duration). Returns partition
/// keys: merged survivors share `cluster_key`; outliers get solo keys.
pub fn duration_partitions(
    cluster_key: &str,
    rows: &[(String, String, i64, u32)],
) -> Vec<(String, String, String)> {
    // (server_id, track_id, duration_sec, priority_rank)
    if rows.is_empty() {
        return Vec::new();
    }
    let mut sorted = rows.to_vec();
    sorted.sort_by_key(|(_, _, _, rank)| *rank);
    let reference_duration = sorted[0].2;

    let mut merged: Vec<&(String, String, i64, u32)> = Vec::new();
    let mut outliers: Vec<&(String, String, i64, u32)> = Vec::new();
    for row in &sorted {
        if (row.2 - reference_duration).abs() <= DURATION_TOLERANCE_SEC {
            merged.push(row);
        } else {
            outliers.push(row);
        }
    }

    let mut out = Vec::new();
    if !merged.is_empty() {
        merged.sort_by_key(|(_, _, _, rank)| *rank);
        let (sid, tid, _, _) = merged[0];
        out.push((cluster_key.to_string(), sid.clone(), tid.clone()));
    }
    for (sid, tid, _, _) in outliers {
        out.push((solo_partition_key(sid, tid), sid.clone(), tid.clone()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outlier_splits_to_solo_partition() {
        let rows = vec![
            ("s1".into(), "t1".into(), 180, 0),
            ("s2".into(), "t2".into(), 182, 1),
            ("s3".into(), "t3".into(), 240, 2),
        ];
        let parts = duration_partitions("ck1", &rows);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].0, "ck1");
        assert_eq!(parts[0].1, "s1");
        assert_eq!(parts[1].0, "solo:s3:t3");
    }
}
