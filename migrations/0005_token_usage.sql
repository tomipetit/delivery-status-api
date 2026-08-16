-- One row per billed model call. Until now the only record of spend was a
-- console.info line, which disappears once Workers Logs ages out; the daily
-- report and any month-to-date total need the history to outlive that.
-- tokyo_date is stored rather than derived so the daily report can group by the
-- Asia/Tokyo calendar day without SQLite timezone maths.
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  tokyo_date TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  -- The API can answer without a usage block; the call is billed regardless, so
  -- it is recorded with zeroes and this flag rather than dropped.
  usage_reported INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_token_usage_tokyo_date ON token_usage(tokyo_date);
