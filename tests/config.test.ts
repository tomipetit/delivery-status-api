import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CARRIER_SYNC_CRON = "0 0 * * *";
const POSTAL_REFRESH_CRON = "0 18 1 * *";

async function cronValues(): Promise<string[]> {
  const configText = await readFile(new URL("wrangler.jsonc", `file://${process.cwd()}/`), "utf8");
  return [...configText.matchAll(/"crons"\s*:\s*\[(.*?)\]/gs)]
    .flatMap(([, entries]) => [...entries.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

test("scheduled synchronization runs once per day", async () => {
  assert.equal((await cronValues())[0], CARRIER_SYNC_CRON);
});

test("the monthly postal refresh is a separate trigger the Worker branches on", async () => {
  assert.deepEqual(await cronValues(), [CARRIER_SYNC_CRON, POSTAL_REFRESH_CRON]);

  // The daily carrier sync and the monthly refresh must never share an
  // invocation, which only holds while the branch matches the configured cron.
  const worker = await readFile(new URL("src/index.ts", `file://${process.cwd()}/`), "utf8");
  assert.match(worker, new RegExp(`POSTAL_REFRESH_CRON = "${POSTAL_REFRESH_CRON.replace(/\*/g, "\\*")}"`));
  assert.match(worker, /controller\.cron === POSTAL_REFRESH_CRON/);
});
