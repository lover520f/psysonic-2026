//! Per-member music-folder (`library_scope`) filters for merged cluster queries.

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;

use crate::search::library_scope_equals_sql;

/// `(sql_suffix, bind_params)` — AND ( (server + optional scope) OR … ).
pub(crate) fn scope_filter_sql_and_params(
    table_alias: &str,
    servers_ordered: &[String],
    scopes: &HashMap<String, String>,
) -> (String, Vec<SqlValue>) {
    if scopes.is_empty() {
        return (String::new(), Vec::new());
    }
    let eq = library_scope_equals_sql(table_alias);
    let mut parts = Vec::with_capacity(servers_ordered.len());
    let mut params = Vec::new();
    for sid in servers_ordered {
        if let Some(scope) = scopes.get(sid) {
            parts.push(format!("({table_alias}.server_id = ? AND {eq})"));
            params.push(SqlValue::Text(sid.clone()));
            params.push(SqlValue::Text(scope.clone()));
        } else {
            parts.push(format!("({table_alias}.server_id = ?)"));
            params.push(SqlValue::Text(sid.clone()));
        }
    }
    (format!(" AND ({})", parts.join(" OR ")), params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_filter_empty_when_no_scopes() {
        let (sql, params) = scope_filter_sql_and_params("t", &["s1".into()], &HashMap::new());
        assert!(sql.is_empty());
        assert!(params.is_empty());
    }

    #[test]
    fn scope_filter_binds_scoped_and_unscoped_members() {
        let mut scopes = HashMap::new();
        scopes.insert("s1".into(), "lib-a".into());
        let (sql, params) = scope_filter_sql_and_params(
            "t",
            &["s1".into(), "s2".into()],
            &scopes,
        );
        assert!(sql.contains("t.server_id = ?"));
        assert_eq!(params.len(), 3);
    }
}
