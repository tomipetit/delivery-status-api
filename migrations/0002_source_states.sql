CREATE TABLE IF NOT EXISTS carrier_source_states (
  carrier TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  last_checked_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS carrier_source_articles (
  carrier TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  source_updated_at TEXT,
  restrictions_json TEXT NOT NULL DEFAULT '[]',
  extractor_version TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (carrier, source_url)
);

CREATE INDEX IF NOT EXISTS idx_carrier_source_articles_carrier
  ON carrier_source_articles (carrier);
