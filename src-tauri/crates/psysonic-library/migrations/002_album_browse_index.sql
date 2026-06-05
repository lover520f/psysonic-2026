-- Plain All Albums browse: read from `album` with ORDER BY name (not track GROUP BY).
CREATE INDEX IF NOT EXISTS idx_album_server_name_browse
  ON album(server_id, name COLLATE NOCASE);

-- Scoped album EXISTS probes: (server, album, library) on live tracks.
CREATE INDEX IF NOT EXISTS idx_track_server_album_library_browse
  ON track(server_id, album_id, library_id)
  WHERE deleted = 0
    AND album_id IS NOT NULL
    AND album_id != '';
