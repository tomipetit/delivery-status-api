import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { parseKenAllCsv } from "../src/postal/ken-all.ts";
import { ISLAND_MUNICIPALITIES, islandMunicipalities } from "../src/postal/islands.ts";
import { areaFragments, createMunicipalityRowCache, resolvePostalCodes } from "../src/postal/lookup.ts";
import { monthlyArchiveNames, refreshPostalCodes } from "../src/postal/refresh.ts";
import { readZipCsvText } from "../src/postal/zip.ts";
import { listRestrictions } from "../src/storage/restrictions.ts";
import { createInMemoryD1, type StoredPostalCodeRow } from "./helpers/in-memory-d1.ts";

function postalRow(postal_code: string, prefecture: string, city: string, town: string): StoredPostalCodeRow {
  return { postal_code, prefecture, city, town };
}

/**
 * A slice of KEN_ALL shaped like the real thing: 珠洲市 carries the town names a
 * Yamato row names with parenthesised sub-localities, 輪島市 carries a town
 * whose KEN_ALL name is longer than the source's, and the 大島郡 municipalities
 * carry the island codes — including 和泊町/知名町 and 与論町, which share the
 * 8919 prefix and can only be told apart by municipality.
 */
const kenAllSample: StoredPostalCodeRow[] = [
  postalRow("9271201", "石川県", "珠洲市", "宝立町大町"),
  postalRow("9271202", "石川県", "珠洲市", "宝立町二艘丹"),
  postalRow("9271203", "石川県", "珠洲市", "宝立町鵜飼"),
  postalRow("9271301", "石川県", "珠洲市", "若山町白滝"),
  postalRow("9271302", "石川県", "珠洲市", "若山町洲巻"),
  postalRow("9274401", "石川県", "珠洲市", "上戸町北方"),
  postalRow("9280001", "石川県", "輪島市", "以下に掲載がない場合"),
  postalRow("9272165", "石川県", "輪島市", "門前町西円山ハ"),
  postalRow("9272166", "石川県", "輪島市", "別所谷町"),
  postalRow("8916101", "鹿児島県", "大島郡喜界町", "赤連"),
  postalRow("8916102", "鹿児島県", "大島郡喜界町", "湾"),
  postalRow("8919111", "鹿児島県", "大島郡和泊町", "内城"),
  postalRow("8919211", "鹿児島県", "大島郡知名町", "知名"),
  postalRow("8919301", "鹿児島県", "大島郡与論町", "茶花"),
  postalRow("8940000", "鹿児島県", "奄美市", "以下に掲載がない場合"),
  postalRow("8941201", "鹿児島県", "大島郡龍郷町", "赤尾木"),
  postalRow("9010141", "沖縄県", "那覇市", "宇栄原"),
];

function memory() {
  return createInMemoryD1({ postalCodes: kenAllSample });
}

function restriction(prefecture: string, city: string | null, area: string | null) {
  return { prefecture, city, area };
}

test("parenthesised sub-localities are stripped before the area is split", () => {
  assert.deepEqual(
    areaFragments("宝立町（大町泥木・大町・二艘丹）・若山町（白滝・南山・洲巻）"),
    ["宝立町", "若山町"],
  );
  assert.deepEqual(areaFragments("門前町西円山, 別所谷町、上戸町"), ["門前町西円山", "別所谷町", "上戸町"]);
  assert.deepEqual(areaFragments("輪島市(全域)"), ["輪島市"]);
});

test("a town match uses the stripped fragments and matches in both directions", async () => {
  const { db } = memory();

  const grouped = await resolvePostalCodes(
    db,
    restriction("石川県", "珠洲市", "宝立町（大町泥木・大町・二艘丹）・若山町（白滝・南山・洲巻）"),
  );
  assert.equal(grouped.level, "town");
  assert.deepEqual(
    grouped.codes,
    ["9271201", "9271202", "9271203", "9271301", "9271302"],
    "every 宝立町/若山町 town resolves; the unrelated 上戸町 must not",
  );

  // KEN_ALL is longer than the source: 門前町西円山 vs 門前町西円山ハ.
  const longerInDataset = await resolvePostalCodes(db, restriction("石川県", "輪島市", "門前町西円山・別所谷町"));
  assert.equal(longerInDataset.level, "town");
  assert.deepEqual(longerInDataset.codes, ["9272165", "9272166"]);

  // The source is longer than KEN_ALL: 宝立町大町泥木 vs 宝立町大町.
  const longerInSource = await resolvePostalCodes(db, restriction("石川県", "珠洲市", "宝立町大町泥木"));
  assert.equal(longerInSource.level, "town");
  assert.deepEqual(longerInSource.codes, ["9271201"]);
});

test("a municipality without a usable area falls back to every code it has", async () => {
  const { db } = memory();

  const wholeCity = await resolvePostalCodes(db, restriction("石川県", "珠洲市", null));
  assert.equal(wholeCity.level, "city");
  assert.deepEqual(wholeCity.codes, ["9271201", "9271202", "9271203", "9271301", "9271302", "9274401"]);

  // An area naming nothing KEN_ALL knows must widen to the municipality rather
  // than drop to the prefecture or invent a match.
  const unknownArea = await resolvePostalCodes(db, restriction("石川県", "輪島市", "海岸沿いの一部地域"));
  assert.equal(unknownArea.level, "city");
  assert.deepEqual(unknownArea.codes, ["9272165", "9272166", "9280001"]);
});

test("an island without a municipality resolves through the municipalities it consists of", async () => {
  const { db } = memory();

  const kikai = await resolvePostalCodes(db, restriction("鹿児島県", null, "喜界島"));
  assert.equal(kikai.level, "city", "an island resolves to whole municipalities");
  assert.deepEqual(kikai.codes, ["8916101", "8916102"]);

  // 沖永良部島 and 与論島 share the 8919 prefix, so only the municipality can
  // separate them. Prefix arithmetic would merge the two.
  const okinoerabu = await resolvePostalCodes(db, restriction("鹿児島県", null, "沖永良部島"));
  assert.deepEqual(okinoerabu.codes, ["8919111", "8919211"]);
  const yoron = await resolvePostalCodes(db, restriction("鹿児島県", null, "与論島"));
  assert.deepEqual(yoron.codes, ["8919301"]);

  const amami = await resolvePostalCodes(db, restriction("鹿児島県", null, "奄美大島全域"));
  assert.deepEqual(amami.codes, ["8940000", "8941201"], "a suffixed island name still resolves");

  assert.deepEqual(islandMunicipalities("喜界島・徳之島"), [
    "大島郡喜界町",
    "大島郡徳之島町",
    "大島郡天城町",
    "大島郡伊仙町",
  ]);
  assert.deepEqual(islandMunicipalities("能登半島"), [], "an unknown area is not an island");
  assert.equal(Object.keys(ISLAND_MUNICIPALITIES).length, 5);
});

test("prefecture level reports the level and no codes at all", async () => {
  const { db } = memory();

  // Enumerating 沖縄県 would be 804 codes that say nothing the prefecture field
  // does not already say, so the list stays empty by design.
  const wholePrefecture = await resolvePostalCodes(db, restriction("沖縄県", null, null));
  assert.deepEqual(wholePrefecture, { codes: [], level: "prefecture" });

  const unknownIsland = await resolvePostalCodes(db, restriction("鹿児島県", null, "見知らぬ島"));
  assert.deepEqual(unknownIsland, { codes: [], level: "prefecture" });

  const unknownMunicipality = await resolvePostalCodes(db, restriction("石川県", "存在しない市", "町名"));
  assert.deepEqual(unknownMunicipality, { codes: [], level: "prefecture" });
});

test("a failing lookup yields no codes instead of throwing", async () => {
  const store = memory();
  store.failPostalLookups();

  assert.deepEqual(
    await resolvePostalCodes(store.db, restriction("石川県", "珠洲市", "宝立町")),
    { codes: [], level: null },
    "postal codes are an enrichment; a broken table must never surface as an error",
  );
  assert.deepEqual(
    await resolvePostalCodes(store.db, restriction("", null, null)),
    { codes: [], level: null },
    "a record without a prefecture cannot be resolved and is not an error either",
  );
});

test("the same municipality is queried once per run", async () => {
  const store = memory();
  const cache = createMunicipalityRowCache();
  let queries = 0;
  const counting = {
    prepare(sql: string) {
      queries += 1;
      return store.db.prepare(sql);
    },
  } as unknown as D1Database;

  await resolvePostalCodes(counting, restriction("石川県", "珠洲市", "宝立町"), cache);
  await resolvePostalCodes(counting, restriction("石川県", "珠洲市", "若山町"), cache);
  assert.equal(queries, 1, "a carrier listing repeats a municipality; the cache must absorb it");
});

test("rows stored before the postal columns existed read back as no codes", async () => {
  const { db } = createInMemoryD1({
    restrictions: [{
      carrier: "yamato",
      prefecture: "石川県",
      city: "輪島市",
      area: null,
      status: "suspended",
      services_json: JSON.stringify(["宅急便"]),
      reason: "大雨",
      // Written before migration 0004; both columns are NULL.
      postal_codes_json: null,
      postal_code_level: null,
      source_url: "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html",
      source_published_at: null,
      checked_at: "2026-08-15T00:00:00.000Z",
    }],
  });

  const [restriction] = await listRestrictions(db);
  assert.deepEqual(restriction.postalCodes, []);
  assert.equal(restriction.postalCodeLevel, null);
});

/** A minimal but valid ZIP: local header, central directory and EOCD record. */
function zipArchive(name: string, content: string): Uint8Array<ArrayBuffer> {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(content, "utf8");
  const compressed = deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBytes.length + compressed.length;
  const centralSize = central.length + nameBytes.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return new Uint8Array(
    Buffer.concat([local, nameBytes, compressed, central, nameBytes, eocd]),
  );
}

function kenAllCsv(rows: Array<[string, string, string, string]>): string {
  return rows
    .map(([code, prefecture, city, town]) =>
      `"01100","000  ","${code}","ホッカイドウ","カナ","カナ","${prefecture}","${city}","${town}",0,0,0,0,0,0`)
    .join("\r\n");
}

test("a ZIP member is located through the central directory and inflated without a dependency", async () => {
  const csv = kenAllCsv([
    ["9271201", "石川県", "珠洲市", "宝立町大町"],
    ["9271202", "石川県", "珠洲市", "宝立町二艘丹"],
  ]);
  const text = await readZipCsvText(zipArchive("utf_add_2607.csv", csv));

  assert.equal(text, csv);
  assert.deepEqual(parseKenAllCsv(text), [
    { postalCode: "9271201", prefecture: "石川県", city: "珠洲市", town: "宝立町大町" },
    { postalCode: "9271202", prefecture: "石川県", city: "珠洲市", town: "宝立町二艘丹" },
  ]);
});

test("KEN_ALL parsing keeps only complete rows", () => {
  const csv = [
    kenAllCsv([["9271201", "石川県", "珠洲市", "宝立町大町"]]),
    '"01100","000  ","927120","カナ","カナ","カナ","石川県","珠洲市","短すぎる郵便番号",0',
    '"01100","000  ","9271203","カナ","カナ","カナ","石川県","珠洲市","",0',
    "",
  ].join("\r\n");

  assert.deepEqual(parseKenAllCsv(csv).map((record) => record.postalCode), ["9271201"]);
});

test("the monthly archive names follow the Tokyo calendar month", () => {
  // The trigger fires on the 1st at 18:00 UTC, which is already the 2nd in Tokyo.
  assert.deepEqual(monthlyArchiveNames(new Date("2026-07-01T18:00:00Z")), {
    yymm: "2607",
    add: "utf_add_2607.zip",
    del: "utf_del_2607.zip",
  });
  assert.equal(monthlyArchiveNames(new Date("2026-12-31T16:00:00Z")).yymm, "2701");
});

const refreshBase = "https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/";

test("the monthly refresh applies deletions before insertions", async () => {
  const store = memory();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${refreshBase}utf_del_2607.zip`) {
      return new Response(zipArchive("utf_del_2607.csv", kenAllCsv([
        ["9274401", "石川県", "珠洲市", "上戸町北方"],
      ])));
    }
    if (url === `${refreshBase}utf_add_2607.zip`) {
      return new Response(zipArchive("utf_add_2607.csv", kenAllCsv([
        ["9274402", "石川県", "珠洲市", "上戸町南方"],
        ["9271203", "石川県", "珠洲市", "宝立町鵜飼"],
      ])));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await refreshPostalCodes(store.db, new Date("2026-07-01T18:00:00Z"));
    assert.deepEqual(result, { yymm: "2607", deleted: 1, added: 2, missing: [] });

    const suzu = store.postalCodeRows.filter((row) => row.city === "珠洲市").map((row) => row.postal_code);
    assert.ok(!suzu.includes("9274401"), "a deleted row must be gone");
    assert.ok(suzu.includes("9274402"), "an added row must be present");
    assert.equal(
      suzu.filter((code) => code === "9271203").length,
      1,
      "re-adding an existing row must not duplicate it",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a month with no published archives is a no-op, not a failure", async () => {
  const store = memory();
  const before = store.postalCodeRows.length;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });

  try {
    const result = await refreshPostalCodes(store.db, new Date("2026-07-01T18:00:00Z"));
    assert.deepEqual(result, {
      yymm: "2607",
      deleted: 0,
      added: 0,
      missing: ["utf_del_2607.zip", "utf_add_2607.zip"],
    });
    assert.equal(store.postalCodeRows.length, before, "a missing archive must change nothing");
    assert.equal(store.batches.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failing download is reported rather than silently treated as empty", async () => {
  const store = memory();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    await assert.rejects(
      refreshPostalCodes(store.db, new Date("2026-07-01T18:00:00Z")),
      /utf_del_2607\.zip fetch failed: 500/,
    );
    assert.equal(store.batches.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
