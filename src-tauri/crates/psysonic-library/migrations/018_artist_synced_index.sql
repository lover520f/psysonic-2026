-- Speeds up the orphan-artist prune's freshness check: the prune keeps the
-- freshest getArtists pass per server (MAX(synced_at)) and deletes stale rows
-- below it. Without this index that lookup scans every artist row for the
-- server on each sync; the composite index turns it into a seek + range.
CREATE INDEX IF NOT EXISTS idx_artist_synced ON artist(server_id, synced_at);
