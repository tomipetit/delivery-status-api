import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("source-state migration persists carrier fingerprints and per-article Sagawa cache", async () => {
  const migration = await readFile(
    new URL("migrations/0002_source_states.sql", `file://${process.cwd()}/`),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS carrier_source_states/);
  for (const column of ["fingerprint", "source_urls_json", "last_checked_at", "last_changed_at"]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }

  assert.match(migration, /CREATE TABLE IF NOT EXISTS carrier_source_articles/);
  for (const column of ["source_url", "restrictions_json", "extractor_version", "last_seen_at"]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /PRIMARY KEY \(carrier, source_url\)/);
});

test("api key migration is additive and stores hashes under a unique lookup column", async () => {
  const migration = await readFile(
    new URL("migrations/0003_api_keys.sql", `file://${process.cwd()}/`),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS api_keys/);
  for (const column of ["name", "key_hash", "created_at", "revoked_at", "last_used_at"]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /key_hash TEXT NOT NULL UNIQUE/);

  // Applied migrations must never be rewritten, and nothing outside the new
  // table may be touched.
  assert.doesNotMatch(migration, /ALTER TABLE/i);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /delivery_restrictions|carrier_source_/);
  // key_hash UNIQUE already indexes the lookup, so no redundant index is created.
  assert.doesNotMatch(migration, /CREATE INDEX/i);
});

test("postal code migration adds a table and columns without touching existing data", async () => {
  const migration = await readFile(
    new URL("migrations/0004_postal_codes.sql", `file://${process.cwd()}/`),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS postal_codes/);
  for (const column of ["postal_code", "prefecture", "city", "town"]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  // (prefecture, city) is the lookup path used by every resolution.
  assert.match(migration, /CREATE INDEX IF NOT EXISTS \w+\s+ON postal_codes \(prefecture, city\)/);

  // Additive only: ADD COLUMN is safe in place on the production table, and
  // nothing may drop or rewrite what is already stored.
  assert.match(migration, /ALTER TABLE delivery_restrictions ADD COLUMN postal_codes_json TEXT/);
  assert.match(migration, /ALTER TABLE delivery_restrictions ADD COLUMN postal_code_level TEXT/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bUPDATE\b|\bDELETE\b/i);
});
