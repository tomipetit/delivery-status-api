CREATE TABLE IF NOT EXISTS delivery_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  city TEXT,
  area TEXT,
  status TEXT NOT NULL,
  services_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  source_url TEXT NOT NULL,
  source_published_at TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_restrictions_carrier
  ON delivery_restrictions (carrier);

CREATE INDEX IF NOT EXISTS idx_delivery_restrictions_location
  ON delivery_restrictions (prefecture, city, area);
