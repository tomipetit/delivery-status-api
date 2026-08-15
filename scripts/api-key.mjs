import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const usage = `Usage:
  npm run key:issue  -- --name "<label>" [--remote]
  npm run key:list   -- [--remote]
  npm run key:revoke -- --id <n> [--remote]
  npm run key:revoke -- --name "<label>" [--remote]

Without --remote every command targets the LOCAL D1 database.
Client keys are stored as SHA-256 hashes only: a lost key is reissued, never recovered.`;

function fail(message) {
  console.error(`error: ${message}`);
  console.error("");
  console.error(usage);
  process.exit(1);
}

/** Database name comes from wrangler.jsonc so the CLI cannot drift from the Worker. */
function databaseName() {
  try {
    const config = readFileSync(join(projectRoot, "wrangler.jsonc"), "utf8");
    const match = /"database_name"\s*:\s*"([^"]+)"/.exec(config);
    if (match) return match[1];
  } catch {
    // Fall through to the default below.
  }
  return "delivery-status";
}

/**
 * SQL literal quoting. Values are also validated before they get here, so this
 * is the second of two layers; neither alone is trusted.
 */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function validName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length === 0 || name.length > 100) return null;
  // Quotes, backslashes and control characters have no place in a label and
  // are exactly what a SQL injection attempt would need, so they are rejected
  // rather than escaped away. Ordinary spaces and Japanese labels are fine.
  if (/["']/.test(name) || name.includes(String.fromCharCode(92))) return null;
  if ([...name].some((char) => char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f)) return null;
  return name;
}

function validId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  return Number(value);
}

function wranglerCommand() {
  const local = join(projectRoot, "node_modules", ".bin", "wrangler");
  return existsSync(local) ? { command: local, prefix: [] } : { command: "npx", prefix: ["wrangler"] };
}

/**
 * Runs one statement through `wrangler d1 execute`. The SQL travels as a single
 * argv entry with no shell involved, so nothing in it can be reinterpreted by a
 * shell; stdin/stderr stay attached so wrangler's own production confirmation
 * prompt still reaches the operator.
 */
function execute(sql, { remote }) {
  const { command, prefix } = wranglerCommand();
  const args = [
    ...prefix,
    "d1",
    "execute",
    databaseName(),
    remote ? "--remote" : "--local",
    "--json",
    "--command",
    sql,
  ];

  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.error) fail(`could not run wrangler: ${result.error.message}`);
  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    fail(`wrangler exited with code ${result.status}`);
  }

  const stdout = result.stdout ?? "";
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) return { results: [], meta: null, raw: stdout };

  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return { results: [], meta: null, raw: stdout };
  }

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    results: Array.isArray(first?.results) ? first.results : [],
    meta: first?.meta ?? null,
    raw: stdout,
  };
}

function targetLabel(remote) {
  return remote
    ? `REMOTE (production) database "${databaseName()}"`
    : `LOCAL database "${databaseName()}"`;
}

function announceTarget(remote) {
  if (remote) {
    console.log("!!! TARGET: REMOTE / PRODUCTION !!!");
  }
  console.log(`target: ${targetLabel(remote)}`);
  console.log("");
}

function issue(values, remote) {
  const name = validName(values.name);
  if (name === null) {
    fail("--name is required: 1-100 characters, without quotes, backslashes or control characters");
  }

  // 32 random bytes, prefixed so the credential is recognisable in logs and to
  // secret scanners. Only the hash is sent to D1; the plaintext exists in this
  // process and in the operator's terminal, nowhere else.
  const key = `dsa_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(key, "utf8").digest("hex");

  announceTarget(remote);
  execute(
    `INSERT INTO api_keys (name, key_hash) VALUES (${sqlString(name)}, ${sqlString(keyHash)})`,
    { remote },
  );

  const created = execute(
    `SELECT id, name, created_at FROM api_keys WHERE key_hash = ${sqlString(keyHash)}`,
    { remote },
  ).results[0];

  console.log(`issued API key for ${JSON.stringify(name)}${created ? ` (id ${created.id})` : ""}`);
  console.log(`target: ${targetLabel(remote)}`);
  console.log("");
  console.log(key);
  console.log("");
  console.log("This is shown only now. The database stores a SHA-256 hash, so the key");
  console.log("cannot be recovered later - a lost key is revoked and reissued.");
}

function list(remote) {
  announceTarget(remote);
  const rows = execute(
    "SELECT id, name, created_at, revoked_at, last_used_at FROM api_keys ORDER BY id",
    { remote },
  ).results;

  if (rows.length === 0) {
    console.log("no API keys (the admin API_KEY secret is not stored in D1 and is not listed here)");
    return;
  }

  // No key material can appear here even by accident: only hashes are stored.
  console.table(rows.map((row) => ({
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? "-",
    last_used_at: row.last_used_at ?? "-",
  })));
}

function revoke(values, remote) {
  const hasId = values.id !== undefined;
  const hasName = values.name !== undefined;
  if (hasId === hasName) fail("revoke needs exactly one of --id <n> or --name \"<label>\"");

  let where;
  let description;
  if (hasId) {
    const id = validId(values.id);
    if (id === null) fail("--id must be a positive integer");
    where = `id = ${id}`;
    description = `id ${id}`;
  } else {
    const name = validName(values.name);
    if (name === null) {
      fail("--name must be 1-100 characters, without quotes, backslashes or control characters");
    }
    where = `name = ${sqlString(name)}`;
    description = JSON.stringify(name);
  }

  announceTarget(remote);
  const matches = execute(
    `SELECT id, name, revoked_at FROM api_keys WHERE ${where} ORDER BY id`,
    { remote },
  ).results;

  if (matches.length === 0) {
    fail(`no API key matches ${description} in the ${targetLabel(remote)}`);
  }
  if (matches.length > 1) {
    fail(
      `${matches.length} API keys match ${description} (ids ${matches.map((row) => row.id).join(", ")}); revoke by --id`,
    );
  }

  const [match] = matches;
  if (match.revoked_at !== null && match.revoked_at !== undefined) {
    fail(`API key ${description} was already revoked at ${match.revoked_at}; nothing changed`);
  }

  execute(
    `UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ${Number(match.id)} AND revoked_at IS NULL`,
    { remote },
  );

  const after = execute(
    `SELECT revoked_at FROM api_keys WHERE id = ${Number(match.id)}`,
    { remote },
  ).results[0];

  if (!after || after.revoked_at === null || after.revoked_at === undefined) {
    fail(`revocation of API key ${description} did not take effect`);
  }

  console.log(`revoked API key ${JSON.stringify(match.name)} (id ${match.id}) at ${after.revoked_at}`);
  console.log(`target: ${targetLabel(remote)}`);
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      name: { type: "string" },
      id: { type: "string" },
      remote: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
} catch (error) {
  fail(error.message);
}

const { values, positionals } = parsed;
const [subcommand] = positionals;

if (values.help || subcommand === undefined) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}

if (positionals.length > 1) fail(`unexpected arguments: ${positionals.slice(1).join(" ")}`);

switch (subcommand) {
  case "issue":
    issue(values, values.remote);
    break;
  case "list":
    list(values.remote);
    break;
  case "revoke":
    revoke(values, values.remote);
    break;
  default:
    fail(`unknown subcommand ${JSON.stringify(subcommand)}`);
}
