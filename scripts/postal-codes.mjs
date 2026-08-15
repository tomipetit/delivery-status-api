import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inflateRawSync } from "node:zlib";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const usage = `Usage:
  npm run postal:import -- [--remote] [--dry-run]

Downloads the official 郵便番号データ (KEN_ALL, UTF-8) and replaces the whole
postal_codes table with it. About 124,500 rows; the monthly difference is
applied by the Worker afterwards and this command is not needed again.

Without --remote the LOCAL D1 database is the target.
--dry-run downloads and parses the dataset but writes nothing.`;

// Note the host path: the older zipcode/dl/utf/zip/... URL 404s.
const KEN_ALL_URL =
  "https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip";

/** One INSERT carries this many rows; one file carries this many statements' worth of rows. */
const ROWS_PER_STATEMENT = 500;
const ROWS_PER_FILE = 20_000;

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
 * SQL literal quoting. Every value written here also passed the field
 * validation in parseKenAllCsv, so this is the second of two layers.
 */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function wranglerCommand() {
  const local = join(projectRoot, "node_modules", ".bin", "wrangler");
  return existsSync(local) ? { command: local, prefix: [] } : { command: "npx", prefix: ["wrangler"] };
}

/**
 * Runs wrangler d1 execute. Arguments travel as separate argv entries with no
 * shell involved, and stdin/stderr stay attached so wrangler's own production
 * confirmation prompt still reaches the operator.
 */
function execute(args, { remote }) {
  const { command, prefix } = wranglerCommand();
  const result = spawnSync(
    command,
    [...prefix, "d1", "execute", databaseName(), remote ? "--remote" : "--local", "--json", ...args],
    { cwd: projectRoot, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.error) fail(`could not run wrangler: ${result.error.message}`);
  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    fail(`wrangler exited with code ${result.status}`);
  }

  const stdout = result.stdout ?? "";
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) return { results: [] };

  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return { results: Array.isArray(first?.results) ? first.results : [] };
  } catch {
    return { results: [] };
  }
}

function targetLabel(remote) {
  return remote
    ? `REMOTE (production) database "${databaseName()}"`
    : `LOCAL database "${databaseName()}"`;
}

function announceTarget(remote) {
  if (remote) {
    console.log("!!! TARGET: REMOTE / PRODUCTION !!!");
    console.log("!!! postal_codes will be emptied and reloaded in production !!!");
  }
  console.log(`target: ${targetLabel(remote)}`);
  console.log("");
}

/**
 * Just enough ZIP to read this one archive, with no dependency: Node has no ZIP
 * reader, and shelling out to `unzip` would make the command depend on the
 * operator's machine. The entry is located through the central directory (the
 * local header may legally omit the sizes) and inflated with zlib. The Worker
 * does the same parsing in src/postal/zip.ts against DecompressionStream; the
 * two must stay in agreement.
 */
function readZipCsv(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let offset = buffer.byteLength - 22; offset >= Math.max(0, buffer.byteLength - (22 + 0xffff)); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) fail("downloaded file is not a ZIP archive");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) fail("corrupt ZIP central directory");
    const nameLength = view.getUint16(offset + 28, true);
    entries.push({
      name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }

  const entry = entries.find((candidate) => candidate.name.toLowerCase().endsWith(".csv")) ?? entries[0];
  if (!entry) fail("ZIP archive contains no files");
  const header = entry.localHeaderOffset;
  if (view.getUint32(header, true) !== 0x04034b50) fail("corrupt ZIP local file header");
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const compressed = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return { name: entry.name, text: compressed.toString("utf8") };
  if (entry.method !== 8) fail(`unsupported ZIP compression method ${entry.method}`);
  return { name: entry.name, text: inflateRawSync(compressed).toString("utf8") };
}

/** Fields are quoted; a doubled quote inside a quoted field is one quote. */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else if (char !== "\r") field += char;
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

/**
 * Columns: 2 郵便番号(7桁), 6 都道府県, 7 市区町村, 8 町域. Nothing else is
 * stored — the lookup matches Japanese names, never the kana or the flags.
 */
function parseKenAllCsv(text) {
  const records = [];
  let skipped = 0;
  for (const row of parseCsvRows(text)) {
    const postalCode = (row[2] ?? "").trim();
    const prefecture = (row[6] ?? "").trim();
    const city = (row[7] ?? "").trim();
    const town = (row[8] ?? "").trim();
    if (!/^\d{7}$/.test(postalCode) || !prefecture || !city || !town) {
      skipped += 1;
      continue;
    }
    records.push({ postalCode, prefecture, city, town });
  }
  return { records, skipped };
}

function insertStatement(chunk) {
  const values = chunk
    .map(({ postalCode, prefecture, city, town }) =>
      `(${sqlString(postalCode)},${sqlString(prefecture)},${sqlString(city)},${sqlString(town)})`)
    .join(",");
  return `INSERT INTO postal_codes (postal_code, prefecture, city, town) VALUES ${values};`;
}

async function download() {
  console.log(`downloading ${KEN_ALL_URL}`);
  const response = await fetch(KEN_ALL_URL, { headers: { "user-agent": "delivery-status-api/0.1" } });
  if (!response.ok) fail(`download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`downloaded ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
  return buffer;
}

async function runImport({ remote, dryRun }) {
  announceTarget(remote);

  const { name, text } = readZipCsv(await download());
  console.log(`unzipped ${name}: ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} MB of CSV`);

  const { records, skipped } = parseKenAllCsv(text);
  if (records.length === 0) fail("the downloaded dataset parsed to zero rows; nothing was written");
  console.log(`parsed ${records.length} rows${skipped > 0 ? ` (${skipped} skipped)` : ""}`);
  console.log(`prefectures: ${new Set(records.map((record) => record.prefecture)).size}`);
  console.log("");

  if (dryRun) {
    console.log("--dry-run: the database was not touched");
    return;
  }

  // A single statement cannot carry 124k rows, so the load is split into files
  // and each is executed on its own. The first file empties the table, which
  // means a failure part-way leaves it incomplete: re-run the command, it is
  // a wholesale replacement and is safe to repeat.
  const directory = mkdtempSync(join(tmpdir(), "delivery-status-postal-"));
  try {
    const files = [];
    for (let start = 0; start < records.length; start += ROWS_PER_FILE) {
      const slice = records.slice(start, start + ROWS_PER_FILE);
      const statements = [];
      if (start === 0) statements.push("DELETE FROM postal_codes;");
      for (let offset = 0; offset < slice.length; offset += ROWS_PER_STATEMENT) {
        statements.push(insertStatement(slice.slice(offset, offset + ROWS_PER_STATEMENT)));
      }
      const path = join(directory, `postal-${String(files.length).padStart(3, "0")}.sql`);
      writeFileSync(path, `${statements.join("\n")}\n`, "utf8");
      files.push({ path, rows: slice.length });
    }

    let written = 0;
    for (const [index, file] of files.entries()) {
      const size = (statSync(file.path).size / 1024 / 1024).toFixed(1);
      console.log(`applying batch ${index + 1}/${files.length} (${file.rows} rows, ${size} MB)...`);
      execute(["--file", file.path], { remote });
      written += file.rows;
      console.log(`  ${written}/${records.length} rows written`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const stored = execute(["--command", "SELECT COUNT(*) AS count FROM postal_codes"], { remote })
    .results[0];
  console.log("");
  console.log(`postal_codes now holds ${stored?.count ?? "?"} rows in the ${targetLabel(remote)}`);
  if (stored && Number(stored.count) !== records.length) {
    fail(`expected ${records.length} rows but the database reports ${stored.count}; re-run the import`);
  }
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      remote: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
} catch (error) {
  fail(error.message);
}

const { values, positionals } = parsed;
const [subcommand = "import"] = positionals;

if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (positionals.length > 1) fail(`unexpected arguments: ${positionals.slice(1).join(" ")}`);
if (subcommand !== "import") fail(`unknown subcommand ${JSON.stringify(subcommand)}`);

await runImport({ remote: values.remote, dryRun: values["dry-run"] });
