import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "scripts", "api-key.mjs");

/**
 * Only inputs that are rejected before wrangler is ever spawned are exercised
 * here, so the suite never touches a database.
 */
function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("the CLI refuses values it would otherwise interpolate into SQL", async () => {
  for (const name of ["it's broken", '"quoted"', "back\\slash", "", "x".repeat(101)]) {
    const result = run("issue", "--name", name);
    assert.equal(result.status, 1, `--name ${JSON.stringify(name)} must be rejected`);
    assert.match(result.stderr, /error: --name/);
    assert.doesNotMatch(result.stdout, /target:/, "wrangler must not be reached");
  }

  for (const id of ["0", "1; DROP TABLE api_keys", "abc", "1.5", "01"]) {
    const result = run("revoke", "--id", id);
    assert.equal(result.status, 1, `--id ${JSON.stringify(id)} must be rejected`);
    assert.match(result.stderr, /--id must be a positive integer/);
  }

  // A leading dash never reaches the SQL either; the argument parser stops it.
  const negative = run("revoke", "--id=-1");
  assert.equal(negative.status, 1);
  assert.match(negative.stderr, /--id must be a positive integer/);
});

test("the CLI rejects ambiguous or unknown invocations", () => {
  assert.equal(run("revoke").status, 1);
  assert.match(run("revoke").stderr, /exactly one of --id/);
  assert.equal(run("revoke", "--id", "1", "--name", "a").status, 1);
  assert.equal(run("frobnicate").status, 1);
  assert.match(run("frobnicate").stderr, /unknown subcommand/);
  assert.equal(run().status, 1, "no subcommand prints usage and fails");

  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /key:issue/);
  assert.match(help.stdout, /LOCAL D1 database/);
});

test("the CLI stores a hash and never sends key material to the database", async () => {
  const source = await readFile(script, "utf8");

  assert.match(source, /createHash\("sha256"\)/);
  const insert = /INSERT INTO api_keys \([^)]*\) VALUES \(([^`]*?)\)`/.exec(source);
  assert.ok(insert, "the insert statement must be findable");
  assert.match(insert[1], /keyHash/);
  assert.doesNotMatch(insert[1], /sqlString\(key\)/);
  // The local database is the default; production must be opted into.
  assert.match(source, /remote \? "--remote" : "--local"/);
});
