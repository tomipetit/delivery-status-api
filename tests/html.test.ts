import assert from "node:assert/strict";
import test from "node:test";

import { decodeHtmlEntities, htmlToStructuredText } from "../src/scrapers/html.ts";

test("decodeHtmlEntities resolves the named entities used by carrier pages", () => {
  assert.equal(decodeHtmlEntities("&copy; Yamato"), "© Yamato");
  assert.equal(decodeHtmlEntities("&COPY;"), "©");
  assert.equal(decodeHtmlEntities("A&reg;B&trade;C&yen;100"), "A®B™C¥100");
  assert.equal(decodeHtmlEntities("&middot;&hellip;&mdash;&ndash;&deg;"), "・…—–°");
});

test("decodeHtmlEntities keeps an escaped ampersand escaped", () => {
  assert.equal(decodeHtmlEntities("&amp;copy;"), "&copy;");
});

test("htmlToStructuredText marks table cells and rows", () => {
  const html = "<table><tr><th>都道府県</th><th>備考</th></tr>"
    + "<tr><td>石川県</td><td>停止<br>しております</td></tr></table>";

  assert.equal(
    htmlToStructuredText(html),
    "都道府県 | 備考 | \n石川県 | 停止\nしております |",
  );
});
