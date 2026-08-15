import assert from "node:assert/strict";
import test from "node:test";

import { EXTRACTOR_VERSION } from "../src/ai/terra.ts";

import worker from "../src/index.ts";
import { sha256Hex } from "../src/source-fingerprint.ts";
import { tokyoCalendarDayStartIso } from "../src/tokyo-day.ts";
import {
  createInMemoryD1,
  sourceState,
  storedApiKey,
  type StoredApiKey,
  type StoredRestrictionRow,
} from "./helpers/in-memory-d1.ts";

const adminKey = "admin-secret";
const clientKey = "dsa_live_dGVzdC1jbGllbnQta2V5LTAwMDAwMDAwMDAwMDAwMDA";
const revokedKey = "dsa_live_cmV2b2tlZC1jbGllbnQta2V5LTAwMDAwMDAwMDAwMA";
const unknownKey = "dsa_live_dW5rbm93bi1jbGllbnQta2V5LTAwMDAwMDAwMDAwMDA";
const model = "test-model";

const restrictionRow: StoredRestrictionRow = {
  carrier: "yamato",
  prefecture: "石川県",
  city: "輪島市",
  area: null,
  status: "suspended",
  services_json: JSON.stringify(["宅急便"]),
  reason: "大雨",
  postal_codes_json: JSON.stringify(["9272165", "9272166"]),
  postal_code_level: "city",
  source_url: "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html",
  source_published_at: null,
  checked_at: "2026-08-15T00:00:00.000Z",
};

/**
 * Every carrier already checked during the current Tokyo day, so a sync that
 * reaches the handler short-circuits before any network call.
 */
function skipStates() {
  const checkedAt = new Date().toISOString();
  return {
    yamato: sourceState("yamato", `yamato:v3:rules=${EXTRACTOR_VERSION}:model=${model}:skip`, checkedAt),
    sagawa: sourceState("sagawa", `sagawa:xml-v1:rules=${EXTRACTOR_VERSION}:model=${model}:skip`, checkedAt),
    japan_post: sourceState("japan_post", `japan-post:pdf-v1:rules=${EXTRACTOR_VERSION}:model=${model}:pdfsha=skip`, checkedAt),
  };
}

async function memoryWithKeys(apiKeys: StoredApiKey[]) {
  return createInMemoryD1({
    counts: { yamato: 1, sagawa: 0, japan_post: 0 },
    states: skipStates(),
    restrictions: [restrictionRow],
    apiKeys,
  });
}

function env(db: D1Database) {
  return {
    DB: db,
    API_KEY: adminKey,
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_MODEL: model,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.example.com${path}`, init);
}

function authorized(path: string, key: string, method = "GET"): Request {
  return request(path, { method, headers: { authorization: `Bearer ${key}` } });
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const originals = [console.info, console.warn, console.error] as const;
  console.info = console.warn = console.error = () => undefined;
  try {
    return await run();
  } finally {
    [console.info, console.warn, console.error] = originals;
  }
}

async function defaultKeys(): Promise<StoredApiKey[]> {
  return [
    storedApiKey(1, "client-a", await sha256Hex(clientKey)),
    storedApiKey(2, "client-b", await sha256Hex(revokedKey), { revoked_at: "2026-08-10 00:00:00" }),
  ];
}

test("health stays reachable without any credential", async () => {
  const memory = await memoryWithKeys(await defaultKeys());
  const response = await worker.fetch(request("/health"), env(memory.db));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the admin key reaches restrictions and sync", async () => {
  const memory = await memoryWithKeys(await defaultKeys());

  const restrictions = await worker.fetch(authorized("/api/v1/restrictions", adminKey), env(memory.db));
  assert.equal(restrictions.status, 200);
  assert.deepEqual(await restrictions.json(), {
    data: [{
      carrier: "yamato",
      prefecture: "石川県",
      city: "輪島市",
      area: null,
      status: "suspended",
      services: ["宅急便"],
      reason: "大雨",
      postalCodes: ["9272165", "9272166"],
      postalCodeLevel: "city",
      sourceUrl: restrictionRow.source_url,
      sourcePublishedAt: null,
      checkedAt: restrictionRow.checked_at,
    }],
    count: 1,
  });

  const sync = await quiet(() =>
    worker.fetch(authorized("/api/v1/sync", adminKey, "POST"), env(memory.db))
  );
  assert.equal(sync.status, 200);
  assert.deepEqual(await sync.json(), {
    ok: true,
    counts: { yamato: 1, sagawa: 0, japan_post: 0 },
  });
});

test("a client key reads restrictions but is forbidden from spending money on sync", async () => {
  const memory = await memoryWithKeys(await defaultKeys());

  const restrictions = await worker.fetch(authorized("/api/v1/restrictions", clientKey), env(memory.db));
  assert.equal(restrictions.status, 200);
  assert.equal((await restrictions.json() as { count: number }).count, 1);

  const sync = await quiet(() =>
    worker.fetch(authorized("/api/v1/sync", clientKey, "POST"), env(memory.db))
  );
  assert.equal(sync.status, 403);
  assert.deepEqual(await sync.json(), { error: "Forbidden" });
  assert.equal(memory.batches.length, 0, "a forbidden sync must not touch storage");
});

test("carrier filtering still works for a client key", async () => {
  const memory = await memoryWithKeys(await defaultKeys());

  const filtered = await worker.fetch(
    authorized("/api/v1/restrictions?carrier=sagawa", clientKey),
    env(memory.db),
  );
  assert.equal(filtered.status, 200);
  assert.deepEqual(await filtered.json(), { data: [], count: 0 });

  const invalid = await worker.fetch(
    authorized("/api/v1/restrictions?carrier=nope", clientKey),
    env(memory.db),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Invalid carrier" });
});

test("unknown, revoked, missing and malformed credentials are all 401", async () => {
  const memory = await memoryWithKeys(await defaultKeys());

  const cases: Array<[string, Request]> = [
    ["unknown but well-formed key", authorized("/api/v1/restrictions", unknownKey)],
    ["revoked key", authorized("/api/v1/restrictions", revokedKey)],
    ["revoked key on sync", authorized("/api/v1/sync", revokedKey, "POST")],
    ["missing header", request("/api/v1/restrictions")],
    ["empty bearer", request("/api/v1/restrictions", { headers: { authorization: "Bearer " } })],
    ["wrong scheme", request("/api/v1/restrictions", { headers: { authorization: `Basic ${clientKey}` } })],
    ["bare key", request("/api/v1/restrictions", { headers: { authorization: clientKey } })],
    ["admin key with a trailing character", authorized("/api/v1/restrictions", `${adminKey}x`)],
  ];

  for (const [label, input] of cases) {
    const response = await worker.fetch(input, env(memory.db));
    assert.equal(response.status, 401, label);
    assert.deepEqual(await response.json(), { error: "Unauthorized" }, label);
  }
});

test("only the hash of a key is stored, never the plaintext", async () => {
  const keys = await defaultKeys();
  const memory = await memoryWithKeys(keys);
  await worker.fetch(authorized("/api/v1/restrictions", clientKey), env(memory.db));

  const stored = memory.apiKeys.get(1);
  assert.ok(stored);
  assert.equal(stored.key_hash, await sha256Hex(clientKey));
  assert.match(stored.key_hash, /^[0-9a-f]{64}$/);
  assert.ok(
    !JSON.stringify([...memory.apiKeys.values()]).includes(clientKey),
    "no stored column may contain the presented key",
  );
});

test("usage is recorded once per Tokyo day, not once per request", async () => {
  const memory = await memoryWithKeys(await defaultKeys());

  await worker.fetch(authorized("/api/v1/restrictions", clientKey), env(memory.db));
  const firstUse = memory.apiKeys.get(1)?.last_used_at;
  assert.ok(firstUse, "the first request of the day records usage");
  assert.equal(memory.apiKeyUsageWrites(), 1);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await worker.fetch(authorized("/api/v1/restrictions", clientKey), env(memory.db));
  }
  assert.equal(memory.apiKeys.get(1)?.last_used_at, firstUse, "same day, so nothing is rewritten");
  assert.equal(memory.apiKeyUsageWrites(), 1, "a busy key costs at most one write per day");
});

test("usage recorded before the current Tokyo day is refreshed", async () => {
  const now = new Date();
  const beforeToday = new Date(Date.parse(tokyoCalendarDayStartIso(now)) - 1000).toISOString();
  const memory = await memoryWithKeys([
    storedApiKey(1, "client-a", await sha256Hex(clientKey), { last_used_at: beforeToday }),
  ]);

  await worker.fetch(authorized("/api/v1/restrictions", clientKey), env(memory.db));

  assert.notEqual(memory.apiKeys.get(1)?.last_used_at, beforeToday);
  assert.equal(memory.apiKeyUsageWrites(), 1);
});

test("a D1 failure during key lookup fails closed", async () => {
  const memory = await memoryWithKeys(await defaultKeys());
  memory.failApiKeyLookupOnce();

  const response = await quiet(() =>
    worker.fetch(authorized("/api/v1/restrictions", clientKey), env(memory.db))
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });

  // The same key works again once storage recovers, proving the failure was the
  // cause rather than the key itself.
  const recovered = await worker.fetch(authorized("/api/v1/restrictions", clientKey), env(memory.db));
  assert.equal(recovered.status, 200);
});

test("the admin key keeps working when no client key exists at all", async () => {
  const memory = await memoryWithKeys([]);

  const response = await worker.fetch(authorized("/api/v1/restrictions", adminKey), env(memory.db));
  assert.equal(response.status, 200);
});

test("unknown routes stay 404 for an authenticated principal", async () => {
  const memory = await memoryWithKeys(await defaultKeys());

  const response = await worker.fetch(authorized("/api/v1/nope", clientKey), env(memory.db));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});
