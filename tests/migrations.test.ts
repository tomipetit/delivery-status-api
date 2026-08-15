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
