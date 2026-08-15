import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSagawaArticle,
  fetchSagawaArticleList,
  parseSagawaArticleBody,
  parseSagawaArticleList,
  type SagawaArticleSummary,
} from "../src/scrapers/sagawa.ts";

const listXmlUrl = "https://www2.sagawa-exp.co.jp/sagawa_xml/importance/importance_list.xml";

function articleXmlUrl(id: string): string {
  return `https://www2.sagawa-exp.co.jp/sagawa_xml/importance/importance_detail_${id}.xml`;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function userAgent(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers as HeadersInit | undefined).get("user-agent");
}

// Shaped after importance_list.xml: an <informations> root of <information>
// entries carrying i_id, split date parts, a CDATA title and link_url, plus
// presentation-only fields the parser must ignore. The 396 entry keeps the
// unpadded month/day and the wrapped CDATA title the feed also emits.
const articleListXml = `<?xml version="1.0" encoding="UTF-8"?>
<informations>
  <information>
    <i_id>407</i_id>
    <importance_flag>1</importance_flag>
    <year>2026</year>
    <month>08</month>
    <day>15</day>
    <title><![CDATA[令和8年8月千葉豪雨の影響に伴うお荷物のお届け遅延について（2026年8月15日8時時点）]]></title>
    <kind1>3</kind1>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/407/</link_url>
    <blank_flg>1</blank_flg>
    <new_count>7</new_count>
    <pdf_size/>
    <new_flag>1</new_flag>
  </information>
  <information>
    <i_id>405</i_id>
    <importance_flag>1</importance_flag>
    <year>2026</year>
    <month>08</month>
    <day>12</day>
    <title><![CDATA[天候不良に伴う集配業務への影響について（2026年8月12日8時時点）]]></title>
    <kind1>3</kind1>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/405/</link_url>
    <pdf_size/>
    <new_flag>1</new_flag>
  </information>
  <information>
    <i_id>396</i_id>
    <importance_flag>1</importance_flag>
    <year>2026</year>
    <month>7</month>
    <day>6</day>
    <title><![CDATA[【お盆特設】【8/9～8/17】
      お盆期間中の集配業務のご案内]]></title>
    <kind1>3</kind1>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/396/</link_url>
    <pdf_size/>
    <new_flag>0</new_flag>
  </information>
</informations>
`;

// Shaped after importance_detail_320.xml: a 停止 heading followed by a
// 都道府県/市区郡/地域名 table, then a 遅延 heading with its own table.
const article320Xml = `<?xml version="1.0" encoding="UTF-8"?>
<information>
  <year>2025</year>
  <month>08</month>
  <day>18</day>
  <title><![CDATA[石川県能登半島で発生した地震・大雨に伴う配送への影響について]]></title>
  <kind1>3</kind1>
  <link_url>https://www2.sagawa-exp.co.jp/information/detail/320/</link_url>
  <news><![CDATA[<span><span>【お荷物のお預かり・お届けを停止している地域】</span></span><br /><br />
<table class="article-table">
<thead>
<tr><th scope="rowgroup" nowrap="nowrap">都道府県</th><th scope="rowgroup" nowrap="nowrap">市区郡</th><th scope="rowgroup" nowrap="nowrap">地域名</th></tr>
</thead>
<tbody>
<tr>
<td>石川県</td>
<td>輪島市</td>
<td>小池町,下山町,赤崎町,大沢町,上大沢町,西二又町,東山町,忍町,上黒川町,門前町滝上（10町）</td>
</tr>
</tbody>
</table>
<br /><span style="color: #ff0000;">　<strong>※全国から上記地域への<span style="text-decoration: underline;">お荷物のお預かり（荷受け）は停止しております。</span></strong></span><br /><br />【お荷物のお預かり・お届けが遅れる地域】<br /><br />
<table class="article-table">
<tbody>
<tr>
<td>石川県</td>
<td>珠洲市</td>
<td>全域</td>
</tr>
</tbody>
</table>]]></news>
</information>
`;

// Shaped after importance_detail_357.xml: a service-limited notice naming no
// Japanese prefecture at all.
const article357Xml = `<?xml version="1.0" encoding="UTF-8"?>
<information>
  <year>2025</year>
  <month>08</month>
  <day>26</day>
  <title><![CDATA[米国宛て「飛脚グローバルポスト便」一時停止について]]></title>
  <kind1>3</kind1>
  <link_url>https://www2.sagawa-exp.co.jp/information/detail/357/</link_url>
  <news><![CDATA[<p><span>お客さま各位<br /><br /><strong>🔳 対象サービス</strong><br /><strong>　・飛脚グローバルポスト便（米国宛て）<br /><br /></strong>　該当するお荷物につきましては、8月26日（火）より当面の間、当サービスでの発送を承ることができません。<br /></span></p>]]></news>
</information>
`;

test("parseSagawaArticleList derives canonical article URLs, padded dates, and collapsed titles from the feed", () => {
  assert.deepEqual(parseSagawaArticleList(articleListXml), [
    {
      id: "407",
      url: "https://www2.sagawa-exp.co.jp/information/detail/407/",
      title: "令和8年8月千葉豪雨の影響に伴うお荷物のお届け遅延について（2026年8月15日8時時点）",
      publishedAt: "2026-08-15",
    },
    {
      id: "405",
      url: "https://www2.sagawa-exp.co.jp/information/detail/405/",
      title: "天候不良に伴う集配業務への影響について（2026年8月12日8時時点）",
      publishedAt: "2026-08-12",
    },
    {
      id: "396",
      url: "https://www2.sagawa-exp.co.jp/information/detail/396/",
      title: "【お盆特設】【8/9～8/17】 お盆期間中の集配業務のご案内",
      publishedAt: "2026-07-06",
    },
  ]);
});

test("parseSagawaArticleList throws with a diagnostic excerpt rather than returning an empty list", () => {
  // The entries survive a feed rename but i_id does not, so every entry is
  // dropped: returning [] here would wipe every stored Sagawa restriction.
  const renamedFieldXml = `<?xml version="1.0" encoding="UTF-8"?>
<informations>
  <information>
    <id>407</id>
    <year>2026</year>
    <month>08</month>
    <day>15</day>
    <title><![CDATA[令和8年8月千葉豪雨の影響に伴うお荷物のお届け遅延について]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/407/</link_url>
  </information>
</informations>
`;

  assert.throws(
    () => parseSagawaArticleList(renamedFieldXml),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Sagawa article list contained no parseable entries/);
      assert.match(error.message, /Diagnostic excerpt: /);
      assert.ok(
        error.message.includes("<id>407</id>"),
        "the diagnostic excerpt must show the markup that stopped parsing",
      );
      return true;
    },
  );
});

test("parseSagawaArticleList throws when served the JavaScript-rendered HTML page instead of the XML", () => {
  // What the site returns for /information/list/: the article list is injected
  // by information.js, so the delivered markup carries no entries at all.
  const htmlListPage = [
    "<!DOCTYPE html>",
    '<html lang="ja"><head><title>【佐川急便】お知らせ</title></head>',
    "<body>",
    '<main class="l-main">',
    "<noscript>",
    '<div class="c-noscript">JavaScriptが有効になっていないため、有効にしてから再度操作をお願いします。</div>',
    "</noscript>",
    '<div id="information-list"><ul class="c-news"><!-- JS --></ul></div>',
    "</main>",
    "</body></html>",
  ].join("\n");

  assert.throws(
    () => parseSagawaArticleList(htmlListPage),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Sagawa article list contained no parseable entries/);
      assert.match(error.message, /JavaScriptが有効になっていない/);
      return true;
    },
  );
});

test("parseSagawaArticleList skips a malformed entry and keeps the well-formed ones", () => {
  const partiallyBrokenXml = `<?xml version="1.0" encoding="UTF-8"?>
<informations>
  <information>
    <i_id>407</i_id>
    <year>2026</year>
    <month>08</month>
    <title><![CDATA[日付が欠けているお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/407/</link_url>
  </information>
  <information>
    <i_id></i_id>
    <year>2026</year>
    <month>08</month>
    <day>12</day>
    <title><![CDATA[記事IDが欠けているお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/405/</link_url>
  </information>
  <information>
    <i_id>396</i_id>
    <year>2026</year>
    <month>07</month>
    <day>06</day>
    <title><![CDATA[正常なお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/396/</link_url>
  </information>
</informations>
`;

  assert.deepEqual(parseSagawaArticleList(partiallyBrokenXml), [
    {
      id: "396",
      url: "https://www2.sagawa-exp.co.jp/information/detail/396/",
      title: "正常なお知らせ",
      publishedAt: "2026-07-06",
    },
  ]);
});

test("parseSagawaArticleList skips an entry whose link_url is not its own canonical article URL", () => {
  const hijackedLinkXml = `<?xml version="1.0" encoding="UTF-8"?>
<informations>
  <information>
    <i_id>407</i_id>
    <year>2026</year>
    <month>08</month>
    <day>15</day>
    <title><![CDATA[別ドメインを指すお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp.example.com/information/detail/407/</link_url>
  </information>
  <information>
    <i_id>405</i_id>
    <year>2026</year>
    <month>08</month>
    <day>12</day>
    <title><![CDATA[別記事を指すお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/999/</link_url>
  </information>
  <information>
    <i_id>396</i_id>
    <year>2026</year>
    <month>07</month>
    <day>06</day>
    <title><![CDATA[正常なお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/396/</link_url>
  </information>
</informations>
`;

  const summaries = parseSagawaArticleList(hijackedLinkXml);

  assert.deepEqual(summaries.map((summary) => summary.id), ["396"]);
  assert.deepEqual(
    summaries.map((summary) => summary.url),
    ["https://www2.sagawa-exp.co.jp/information/detail/396/"],
  );
});

test("parseSagawaArticleList skips an entry whose publication date is out of range or impossible", () => {
  const brokenDateXml = `<?xml version="1.0" encoding="UTF-8"?>
<informations>
  <information>
    <i_id>407</i_id>
    <year>26</year>
    <month>08</month>
    <day>15</day>
    <title><![CDATA[年が切り詰められたお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/407/</link_url>
  </information>
  <information>
    <i_id>405</i_id>
    <year>2026</year>
    <month>13</month>
    <day>40</day>
    <title><![CDATA[月日が範囲外のお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/405/</link_url>
  </information>
  <information>
    <i_id>400</i_id>
    <year>2026</year>
    <month>0</month>
    <day>15</day>
    <title><![CDATA[月がゼロのお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/400/</link_url>
  </information>
  <information>
    <i_id>392</i_id>
    <year>2026</year>
    <month>02</month>
    <day>30</day>
    <title><![CDATA[存在しない日のお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/392/</link_url>
  </information>
  <information>
    <i_id>396</i_id>
    <year>2026</year>
    <month>7</month>
    <day>6</day>
    <title><![CDATA[ゼロ埋めされていない正常なお知らせ]]></title>
    <link_url>https://www2.sagawa-exp.co.jp/information/detail/396/</link_url>
  </information>
</informations>
`;

  // A bad date must skip the entry: publishedAt feeds the article fingerprint,
  // so a value like 0026-08-15 would be stored and churn the cache.
  assert.deepEqual(parseSagawaArticleList(brokenDateXml), [
    {
      id: "396",
      url: "https://www2.sagawa-exp.co.jp/information/detail/396/",
      title: "ゼロ埋めされていない正常なお知らせ",
      publishedAt: "2026-07-06",
    },
  ]);
});

test("parseSagawaArticleBody reports no publication date when the body carries an impossible one", () => {
  const brokenDateBodyXml = `<?xml version="1.0" encoding="UTF-8"?>
<information>
  <year>2026</year>
  <month>02</month>
  <day>30</day>
  <title><![CDATA[存在しない日のお知らせ]]></title>
  <link_url>https://www2.sagawa-exp.co.jp/information/detail/392/</link_url>
  <news><![CDATA[<span>お客さま各位</span>]]></news>
</information>
`;

  const document = parseSagawaArticleBody(
    brokenDateBodyXml,
    "https://www2.sagawa-exp.co.jp/information/detail/392/",
  );

  assert.equal(document.publishedAt, null);
  assert.equal(document.title, "存在しない日のお知らせ");
});

test("parseSagawaArticleBody renders the suspension table as pipe-separated rows for the extractor", () => {
  const document = parseSagawaArticleBody(
    article320Xml,
    "https://www2.sagawa-exp.co.jp/information/detail/320/",
  );

  assert.ok(
    document.text.includes("都道府県 | 市区郡 | 地域名 |"),
    "the table heading must reach the extractor as one pipe-separated row",
  );
  assert.ok(
    document.text.includes("石川県 | \n輪島市 | \n小池町,下山町,赤崎町"),
    "the 輪島市 row must stay adjacent to its prefecture cell",
  );
  assert.match(document.text, /門前町滝上（10町） \| /);
});

test("parseSagawaArticleBody keeps both the suspension and the delay headings without judging them", () => {
  const document = parseSagawaArticleBody(
    article320Xml,
    "https://www2.sagawa-exp.co.jp/information/detail/320/",
  );

  assert.match(document.text, /【お荷物のお預かり・お届けを停止している地域】/);
  assert.match(document.text, /【お荷物のお預かり・お届けが遅れる地域】/);
  assert.match(document.text, /お荷物のお預かり（荷受け）は停止しております。/);
  assert.ok(
    document.text.indexOf("珠洲市") > document.text.indexOf("【お荷物のお預かり・お届けが遅れる地域】"),
    "the delayed-only region must stay under the delay heading, not be promoted or dropped",
  );
});

test("parseSagawaArticleBody reports the sagawa carrier, the requested URL, and the body's own metadata", () => {
  const url = "https://www2.sagawa-exp.co.jp/information/detail/357/";
  const document = parseSagawaArticleBody(article357Xml, url);

  assert.equal(document.carrier, "sagawa");
  assert.equal(document.url, url);
  assert.equal(document.publishedAt, "2025-08-26");
  assert.equal(document.title, "米国宛て「飛脚グローバルポスト便」一時停止について");
  assert.match(document.text, /飛脚グローバルポスト便（米国宛て）/);
  assert.doesNotMatch(document.text, /都道府県/);
});

test("parseSagawaArticleBody throws when the article XML carries no news element", () => {
  const url = "https://www2.sagawa-exp.co.jp/information/detail/407/";
  const withoutNews = `<?xml version="1.0" encoding="UTF-8"?>
<information>
  <year>2026</year>
  <month>08</month>
  <day>15</day>
  <title><![CDATA[本文が届かないお知らせ]]></title>
  <link_url>https://www2.sagawa-exp.co.jp/information/detail/407/</link_url>
</information>
`;

  assert.throws(
    () => parseSagawaArticleBody(withoutNews, url),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Sagawa article body was not found for /);
      assert.ok(error.message.includes(url), "the failing article URL must be named");
      assert.match(error.message, /本文が届かないお知らせ/);
      return true;
    },
  );
});

test("parseSagawaArticleBody throws when the news element renders to no text", () => {
  const url = "https://www2.sagawa-exp.co.jp/information/detail/407/";
  const emptyNews = `<?xml version="1.0" encoding="UTF-8"?>
<information>
  <year>2026</year>
  <month>08</month>
  <day>15</day>
  <title><![CDATA[本文が空のお知らせ]]></title>
  <link_url>https://www2.sagawa-exp.co.jp/information/detail/407/</link_url>
  <news><![CDATA[<p><span>&nbsp;</span></p><p><br /></p>]]></news>
</information>
`;

  assert.throws(
    () => parseSagawaArticleBody(emptyNews, url),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Sagawa article body was empty for /);
      assert.ok(error.message.includes(url), "the failing article URL must be named");
      return true;
    },
  );
});

test("fetchSagawaArticleList requests the importance list XML with the project user agent", async () => {
  const requests: Array<{ url: string; userAgent: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: requestUrl(input), userAgent: userAgent(init) });
    return new Response(articleListXml);
  };

  try {
    const summaries = await fetchSagawaArticleList();

    assert.deepEqual(requests, [{ url: listXmlUrl, userAgent: "delivery-status-api/0.1" }]);
    assert.deepEqual(summaries.map((summary) => summary.id), ["407", "405", "396"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchSagawaArticleList throws on a non-ok status instead of parsing an error page", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Service Unavailable", { status: 503 });

  try {
    await assert.rejects(fetchSagawaArticleList(), /Sagawa article list fetch failed: 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchSagawaArticle requests the per-article importance detail XML with the project user agent", async () => {
  const summary: SagawaArticleSummary = {
    id: "320",
    url: "https://www2.sagawa-exp.co.jp/information/detail/320/",
    title: "一覧の見出し",
    publishedAt: "2025-08-18",
  };
  const requests: Array<{ url: string; userAgent: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: requestUrl(input), userAgent: userAgent(init) });
    return new Response(article320Xml);
  };

  try {
    const document = await fetchSagawaArticle(summary);

    assert.deepEqual(requests, [{
      url: articleXmlUrl("320"),
      userAgent: "delivery-status-api/0.1",
    }]);
    assert.equal(document.carrier, "sagawa");
    assert.equal(document.url, summary.url, "the stored URL must be the public article page, not the XML");
    assert.equal(document.title, "石川県能登半島で発生した地震・大雨に伴う配送への影響について");
    assert.equal(document.publishedAt, "2025-08-18");
    assert.match(document.text, /輪島市/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchSagawaArticle throws on a non-ok status and names the article URL", async () => {
  const summary: SagawaArticleSummary = {
    id: "407",
    url: "https://www2.sagawa-exp.co.jp/information/detail/407/",
    title: "一覧の見出し",
    publishedAt: "2026-08-15",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Not Found", { status: 404 });

  try {
    await assert.rejects(
      fetchSagawaArticle(summary),
      /Sagawa article fetch failed \(https:\/\/www2\.sagawa-exp\.co\.jp\/information\/detail\/407\/\): 404/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchSagawaArticle falls back to the list summary title and date when the body XML omits them", async () => {
  const summary: SagawaArticleSummary = {
    id: "407",
    url: "https://www2.sagawa-exp.co.jp/information/detail/407/",
    title: "令和8年8月千葉豪雨の影響に伴うお荷物のお届け遅延について（2026年8月15日8時時点）",
    publishedAt: "2026-08-15",
  };
  const bodyWithoutMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<information>
  <kind1>3</kind1>
  <link_url>https://www2.sagawa-exp.co.jp/information/detail/407/</link_url>
  <news><![CDATA[<p>お客さま各位<br />令和8年8月千葉豪雨に伴う道路状況の悪化や通行止め等の影響により、一部地域にてお荷物のお届けに遅れが生じております。</p>]]></news>
</information>
`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bodyWithoutMetadata);

  try {
    const document = await fetchSagawaArticle(summary);

    assert.equal(document.title, summary.title);
    assert.equal(document.publishedAt, summary.publishedAt);
    assert.match(document.text, /お届けに遅れが生じております/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
