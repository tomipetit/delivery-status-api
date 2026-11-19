import assert from "node:assert/strict";
import test from "node:test";

import { extractYamatoStatusText, yamatoFingerprintText } from "../src/scrapers/yamato.ts";

// Mirrors the published page: one cell per line, a logical row terminated by a
// line ending with "|", and multi-line remarks produced by <br>.
const representativePage = [
  "重要なお知らせ",
  "●下記地域のお荷物について、お届けに遅れが生じております",
  "都道府県 | ",
  "地域詳細 | ",
  "備考 | ",
  "",
  "千葉県 | ",
  "佐倉市上志津 | ",
  "お荷物のお届けに遅れが生じております | ",
  "",
  "●下記地域のお荷物について、荷受けを停止しております",
  "2026年08月15日　14時現在",
  "",
  "制限場所 | ",
  "都道府県 | ",
  "地域詳細 | ",
  "対象商品 | ",
  "理由 | ",
  "備考 | ",
  "",
  "配達地 | ",
  "千葉県 | ",
  "成田市成田国際空港 | ",
  "空港宅急便 | ",
  "空港施設の都合 | ",
  "空港宅急便の荷受けを停止しております | ",
  "",
  "配達地 | ",
  "石川県 | ",
  "輪島市（門前町西円山） | ",
  "全商品 | ",
  "地震・　大雨 | ",
  "現在左記地域を発着とするお荷物のお預かりを停止しております。 | ",
  "",
  " | ",
  " | ",
  "別所谷町 | ",
  "全商品 | ",
  "地震・　大雨 | ",
  "現在左記地域を発着とするお荷物のお預かりを停止しております。 | ",
  "",
  "※なお、上記周辺の地域でも状況により遅延が発生することがございます。",
  "",
  "お問い合わせは、各地域のサービスセンターまでお願いいたします。",
  "",
  "サービスセンター一覧",
  "",
  "営業所の営業状況について",
  "",
  "下記営業所の窓口において、お荷物のお預かり・お引き取りを休止または営業時間を変更しております。",
  "",
  "●営業所受付状況",
  "都道府県 | ",
  "対象営業所 | ",
  "",
  "熊本県 | ",
  "八代営業所 | ",
  "",
  "●集荷・配達停止中地域",
  "2026年08月15日　14時現在",
  "",
  "都道府県 | ",
  "地域詳細 | ",
  "対象商品 | ",
  "理由 | ",
  "備考 | ",
  "",
  "石川県 | ",
  "珠洲市（宝立町（大町泥木・大町・二艘丹）） | ",
  "全商品 | ",
  "地震・　大雨 | ",
  "集荷・配達業務を停止しております。 | ",
  "",
  " | ",
  "仁江町 | ",
  "全商品 | ",
  "地震・　大雨 | ",
  "集荷・配達業務を停止しております。 | ",
  "",
  "熊本県 | ",
  "八代市、宇城市小川町、八代郡氷川町 | ",
  "全商品 | ",
  "地震 | ",
  "【受付時間短縮のお知らせ】",
  "現在、左記地域の『集荷』・『配達』は行っておりますが、当日受付の締め切り時間を変更して業務しております",
  "",
  "・集荷受付締め切り時間　　１５時まで　　",
  "・再配受付締め切り時間　　１７時まで",
  "| ",
  "",
  "© Yamato Transport Co., Ltd. All Rights Reserved.",
].join("\n");

test("extractYamatoStatusText keeps only current suspension evidence with table and rowspan context", () => {
  const extracted = extractYamatoStatusText(representativePage);

  assert.match(extracted, /table headings/);
  assert.match(extracted, /adjacent rows/);
  assert.match(extracted, /blank cell may inherit its prefecture or municipality/);
  assert.doesNotMatch(extracted, /佐倉市/);
  assert.doesNotMatch(extracted, /上志津/);
  assert.doesNotMatch(extracted, /お届けに遅れ/);
  assert.match(extracted, /成田国際空港/);
  assert.match(extracted, /空港宅急便の荷受けを停止/);
  assert.ok(
    extracted.includes("制限場所 | \n都道府県 | \n地域詳細 | \n対象商品 | \n理由 | \n備考 |"),
    "the table heading must remain available to the extractor",
  );
  assert.match(extracted, /輪島市（門前町西円山）/);
  assert.ok(
    extracted.includes(" | \n | \n別所谷町 | "),
    "a continuation row must remain adjacent to the parent region",
  );
  assert.match(extracted, /珠洲市（宝立町/);
  assert.ok(extracted.includes(" | \n仁江町 | "), "a continuation row must stay in the second table");
});

test("extractYamatoStatusText drops a row whose own remarks say pickup and delivery are operating", () => {
  const extracted = extractYamatoStatusText(representativePage);

  assert.doesNotMatch(extracted, /八代市/);
  assert.doesNotMatch(extracted, /受付時間短縮/);
  assert.doesNotMatch(extracted, /集荷』・『配達』は行って/);
  assert.doesNotMatch(extracted, /再配受付締め切り時間/);
});

test("extractYamatoStatusText keeps a suspended row that also announces a shortened window", () => {
  const page = [
    "●集荷・配達停止中地域",
    "都道府県 | ",
    "地域詳細 | ",
    "備考 | ",
    "石川県 | ",
    "輪島市 | ",
    "集荷・配達を停止しております。再開後は受付締め切り時間を変更いたします。 | ",
  ].join("\n");

  const extracted = extractYamatoStatusText(page);

  assert.match(extracted, /輪島市/);
  assert.match(extracted, /集荷・配達を停止しております/);
});

test("extractYamatoStatusText drops notices, the next section preamble, and the page footer", () => {
  const extracted = extractYamatoStatusText(representativePage);

  assert.doesNotMatch(extracted, /上記周辺の地域でも/);
  assert.doesNotMatch(extracted, /サービスセンター/);
  assert.doesNotMatch(extracted, /営業所の営業状況について/);
  assert.doesNotMatch(extracted, /お引き取りを休止/);
  assert.doesNotMatch(extracted, /八代営業所/);
  assert.doesNotMatch(extracted, /Yamato Transport Co\./);
});

test("extractYamatoStatusText rejects a page that has delay information but no suspension section", () => {
  const delayOnlyPage = [
    "重要なお知らせ",
    "●お荷物の集配に遅延が生じている地域",
    "都道府県 | 市区町村 | 町域 | 対象商品 | 理由 | 備考 |",
    "千葉県 | 佐倉市 | 上志津 | 全商品 | 道路状況 | 荷受けは停止しておらず、お届けに遅れが生じております |",
    "●営業所の営業時間に関するお知らせ",
    "一部営業所は営業時間を短縮しております",
  ].join("\n");

  assert.throws(
    () => extractYamatoStatusText(delayOnlyPage),
    /suspension section|停止セクション/i,
  );
});

// The same suspension section with only the "as of" stamp and the municipality
// varying, so a fingerprint difference can only come from one of the two.
function suspensionPage(stamp: string, city: string): string {
  return [
    "●下記地域のお荷物について、荷受けを停止しております",
    stamp,
    "",
    "都道府県 | ",
    "地域詳細 | ",
    "備考 | ",
    "",
    "石川県 | ",
    `${city} | `,
    "現在左記地域を発着とするお荷物のお預かりを停止しております。 | ",
  ].join("\n");
}

test("yamatoFingerprintText ignores the hourly 時現在 restamp so an untouched table stays unchanged", () => {
  const at14 = extractYamatoStatusText(suspensionPage("2026年08月15日　14時現在", "輪島市"));
  const at15 = extractYamatoStatusText(suspensionPage("2026年08月15日　15時現在", "輪島市"));

  assert.notEqual(at14, at15, "the pages really do differ before the timestamp lines are dropped");
  assert.equal(
    yamatoFingerprintText(at14),
    yamatoFingerprintText(at15),
    "an hour-only restamp must not re-trigger a paid extraction",
  );
});

test("yamatoFingerprintText still changes when the suspended municipality changes", () => {
  const wajima = extractYamatoStatusText(suspensionPage("2026年08月15日　14時現在", "輪島市"));
  const suzu = extractYamatoStatusText(suspensionPage("2026年08月15日　15時現在", "珠洲市"));

  assert.notEqual(
    yamatoFingerprintText(wajima),
    yamatoFingerprintText(suzu),
    "a real content edit must survive timestamp stripping",
  );
  assert.match(yamatoFingerprintText(suzu), /珠洲市/);
});

test("yamatoFingerprintText keeps a 時現在 stamp that sits inside a table row or mid-sentence", () => {
  const text = [
    "2026年08月15日　14時現在",
    "石川県 | 輪島市 | 2026年08月15日　14時現在 | ",
    "この情報は2026年08月15日　14時現在のものです。",
  ].join("\n");

  const fingerprint = yamatoFingerprintText(text);

  assert.equal(
    fingerprint,
    [
      "石川県 | 輪島市 | 2026年08月15日　14時現在 | ",
      "この情報は2026年08月15日　14時現在のものです。",
    ].join("\n"),
    "only a line that is nothing but the stamp may be dropped; a stamp in content could be a real change",
  );
});

test("yamatoFingerprintText drops a stamp line whose month, day, and hour are not zero padded", () => {
  const padded = yamatoFingerprintText("2026年08月05日　09時現在\n石川県 | 輪島市 | ");
  const unpadded = yamatoFingerprintText("2026年8月5日 9時現在\n石川県 | 輪島市 | ");

  assert.equal(unpadded, "石川県 | 輪島市 | ");
  assert.equal(unpadded, padded, "padded and unpadded stamps must both leave the same hash input");
});

test("extractYamatoStatusText still sends the 時現在 stamp to the model", () => {
  const extracted = extractYamatoStatusText(representativePage);

  assert.match(
    extracted,
    /2026年08月15日　14時現在/,
    "the model needs the stamp to judge currency; only the fingerprint drops it",
  );
  assert.doesNotMatch(yamatoFingerprintText(extracted), /時現在/);
});

// The 2026-11 redesign: unmarked headings ending in について, tables that mix
// delays, shortened hours and suspensions, and every section repeated in a
// smartphone label/value layout after the PC table.
const redesignedPage = [
  "お荷物の集配および営業所の営業状況について",
  "",
  "お届けの遅延・荷受け停止について",
  "",
  "ただいま、下記地域のお荷物についてお届けに遅れなどが生じております（営業所へのお引取りを含む）。",
  "",
  "2026年11月19日　10時現在",
  "",
  "都道府県 | ",
  "地域詳細 | ",
  "対象商品 | ",
  "制限内容 | ",
  "理由 | ",
  "備考 | ",
  "期間 | ",
  "",
  "東京都 | ",
  "八丈島八丈町・青ヶ島村 | ",
  "全商品 | ",
  "遅延 | ",
  "海上シケによる船便運行の影響 | ",
  "該当地域を発着するお荷物のお届けに遅延が発生いたします。 | ",
  "2025年10月17日",
  "より | ",
  "",
  "鹿児島県 | ",
  "西之表市・奄美市",
  "",
  "・上記地域⇔全国を発着するお荷物",
  "",
  "| ",
  "全商品 | ",
  "遅延 | ",
  "船便運航状況・積載制限の影響 | ",
  "お届けには遅延が発生しております。 | ",
  "2026年11月5日",
  "より | ",
  "",
  "千葉県 | ",
  "成田市成田国際空港 | ",
  "空港宅急便 | ",
  "荷受け停止 | ",
  "空港施設の都合 | ",
  "空港宅急便の荷受けを停止しております | ",
  "2026年11月1日",
  "より | ",
  "",
  "※なお、上記周辺の地域でも状況により遅延が発生することがございます。",
  "",
  "ドライバーによる集荷・配達状況について",
  "",
  "ただいま、下記の地域でのお荷物の集荷・配達について、一時的に制限がでております。",
  "",
  "2026年11月19日　10時現在",
  "",
  "都道府県 | ",
  "地域詳細 | ",
  "対象商品 | ",
  "理由 | ",
  "備考 | ",
  "期間 | ",
  "",
  "石川県 | ",
  "・珠洲市、輪島市",
  "　（※荷受け停止地域を除く） | ",
  "宅急便（ドライ・クール） | ",
  "地震 | ",
  "能登半島地震の影響により、お荷物のお届けに遅延が発生いたします。",
  "※該当地域につきましては安全上１６時頃までの『集荷』１７時頃までの『配達』とさせていただきます。 | ",
  "2026年11月17日",
  "より | ",
  "",
  "石川県 | ",
  "・輪島市",
  "門前町西円山、別所谷町",
  "| ",
  "全商品 | ",
  "地震 | ",
  "能登半島地震の影響により、集荷・配達業務を停止しております。 | ",
  "2026年11月17日",
  "より | ",
  "",
  "お荷物の集配および営業所の営業状況について",
  "",
  "お届けの遅延・荷受け停止について",
  "",
  "都道府県 | ",
  "東京都 | ",
  "",
  "ドライバーによる集荷・配達状況について",
  "",
  "都道府県 | ",
  "石川県 | ",
  "地域詳細 | ",
  "・輪島市 門前町西円山 | ",
].join("\n");

test("extractYamatoStatusText reads the redesigned page with unmarked headings", () => {
  const extracted = extractYamatoStatusText(redesignedPage);

  assert.match(extracted, /お届けの遅延・荷受け停止について/);
  assert.match(extracted, /ドライバーによる集荷・配達状況について/);
  assert.match(extracted, /空港宅急便の荷受けを停止しております/);
  assert.match(extracted, /門前町西円山、別所谷町/);
  assert.match(extracted, /集荷・配達業務を停止しております/);
  // Table headers stay so the model keeps column context.
  assert.match(extracted, /制限内容 \|/);
});

test("extractYamatoStatusText drops delay-only and shortened-hours rows on the redesigned page", () => {
  const extracted = extractYamatoStatusText(redesignedPage);

  assert.doesNotMatch(extracted, /八丈島/);
  assert.doesNotMatch(extracted, /西之表市/);
  assert.doesNotMatch(extracted, /珠洲市、輪島市/);
  assert.doesNotMatch(extracted, /１６時頃までの/);
  assert.doesNotMatch(extracted, /上記周辺の地域でも/);
});

test("extractYamatoStatusText keeps only the first copy of each redesigned section", () => {
  const extracted = extractYamatoStatusText(redesignedPage);

  assert.equal(extracted.match(/ドライバーによる集荷・配達状況について/g)?.length, 1);
  assert.equal(extracted.match(/お届けの遅延・荷受け停止について/g)?.length, 1);
  assert.doesNotMatch(extracted, /・輪島市 門前町西円山 \|/);
});
