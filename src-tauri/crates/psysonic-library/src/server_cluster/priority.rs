//! Priority rank SQL from an ordered server list (index 0 = highest).

use rusqlite::types::Value as SqlValue;

/// Build `CASE server_col WHEN ? THEN 0 … ELSE 9999 END` plus bind values.
pub fn priority_case_sql(server_col: &str, servers_ordered: &[String]) -> (String, Vec<SqlValue>) {
    if servers_ordered.is_empty() {
        return ("9999".to_string(), Vec::new());
    }
    let mut sql = format!("CASE {server_col}");
    let mut params = Vec::with_capacity(servers_ordered.len());
    for (rank, sid) in servers_ordered.iter().enumerate() {
        sql.push_str(&format!(" WHEN ? THEN {rank}"));
        params.push(SqlValue::Text(sid.clone()));
    }
    sql.push_str(" ELSE 9999 END");
    (sql, params)
}

/// `server_id IN (?,?,…)` placeholders and bind values.
pub fn in_list_sql(servers: &[String]) -> (String, Vec<SqlValue>) {
    if servers.is_empty() {
        return ("0".to_string(), Vec::new());
    }
    let placeholders = vec!["?"; servers.len()].join(", ");
    let params = servers
        .iter()
        .map(|s| SqlValue::Text(s.clone()))
        .collect();
    (placeholders, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_case_orders_servers() {
        let (sql, params) = priority_case_sql("t.server_id", &["a".into(), "b".into()]);
        assert!(sql.contains("WHEN ? THEN 0"));
        assert!(sql.contains("WHEN ? THEN 1"));
        assert_eq!(params.len(), 2);
    }
}
