import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scheduled synchronization runs once per day", async () => {
  const configText = await readFile(new URL("wrangler.jsonc", `file://${process.cwd()}/`), "utf8");
  const cronValues = [...configText.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/gs)]
    .flatMap(([, entries]) => [...entries.matchAll(/"([^"]+)"/g)].map((match) => match[1]));

  assert.deepEqual(cronValues, ["0 0 * * *"]);
});
