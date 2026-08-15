-- Japanese postal codes (KEN_ALL, 日本郵便) and the two columns that carry the
-- resolved codes on each delivery restriction.
--
-- Additive only. The table is new, and SQLite's ALTER TABLE ... ADD COLUMN is
-- an in-place, additive operation: the existing production rows of
-- delivery_restrictions keep every value they have and read back as NULL for
-- the two new columns until the next sync rewrites them.
CREATE TABLE IF NOT EXISTS postal_codes (
  postal_code TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  city TEXT NOT NULL,
  town TEXT NOT NULL
);

-- (prefecture, city) is the lookup path. Every resolution loads the rows of one
-- municipality and matches town names in the Worker, because KEN_ALL town names
-- and carrier area names only agree by prefix, never exactly.
CREATE INDEX IF NOT EXISTS idx_postal_codes_municipality
  ON postal_codes (prefecture, city);

ALTER TABLE delivery_restrictions ADD COLUMN postal_codes_json TEXT;
ALTER TABLE delivery_restrictions ADD COLUMN postal_code_level TEXT;
