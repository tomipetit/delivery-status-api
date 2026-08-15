-- Per-client API keys. Only the SHA-256 hash of a key is ever stored, so a
-- lost key can be reissued but never recovered from this table.
-- The UNIQUE constraint on key_hash already provides the lookup index used by
-- authentication, so no separate index is created.
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  last_used_at TEXT
);
