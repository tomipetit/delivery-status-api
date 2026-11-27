import type { SourceDocument } from "../types/restriction";
import { describeHttpFailure } from "../http-failure";
import { decodeHtmlEntities, htmlToStructuredText } from "./html";

const SAGAWA_ARTICLE_LIST_XML_URL =
  "https://www2.sagawa-exp.co.jp/sagawa_xml/importance/importance_list.xml";
const SAGAWA_ARTICLE_PAGE_PREFIX = "https://www2.sagawa-exp.co.jp/information/detail/";

export interface SagawaArticleSummary {
  id: string;
  url: string;
  title: string;
  publishedAt: string;
}

function articleXmlUrl(id: string): string {
  return `https://www2.sagawa-exp.co.jp/sagawa_xml/importance/importance_detail_${id}.xml`;
}

function articlePageUrl(id: string): string {
  return `${SAGAWA_ARTICLE_PAGE_PREFIX}${id}/`;
}

function readElement(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match === null ? null : match[1];
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

// Plain fields are either CDATA or entity-encoded text; both forms must end up
// as the literal value with whitespace collapsed.
function readPlainField(xml: string, name: string): string | null {
  const raw = readElement(xml, name);
  if (raw === null) return null;
  const value = decodeHtmlEntities(stripCdata(raw)).replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : null;
}

const DATE_PARTS = {
  year: { length: 4, min: 1900, max: 2999 },
  month: { length: 2, min: 1, max: 12 },
  day: { length: 2, min: 1, max: 31 },
} as const;

function readDatePart(xml: string, name: keyof typeof DATE_PARTS): string | null {
  const { length, min, max } = DATE_PARTS[name];
  const value = readPlainField(xml, name);
  if (value === null || !/^\d{1,4}$/.test(value)) return null;
  const numeric = Number(value);
  if (numeric < min || numeric > max) return null;
  return String(numeric).padStart(length, "0");
}

// publishedAt feeds the article fingerprint and source_updated_at in D1, so a
// truncated or out-of-range date part must skip the entry rather than become a
// value that churns the fingerprint on every run.
function readPublishedAt(xml: string): string | null {
  const year = readDatePart(xml, "year");
  const month = readDatePart(xml, "month");
  const day = readDatePart(xml, "day");
  if (year === null || month === null || day === null) return null;

  const publishedAt = `${year}-${month}-${day}`;
  const parsed = new Date(`${publishedAt}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects a day that does not exist in that month, such as 2026-02-30.
  return parsed.toISOString().slice(0, 10) === publishedAt ? publishedAt : null;
}

function diagnosticExcerpt(xml: string): string {
  return xml.replace(/\s+/g, " ").trim().slice(0, 600);
}

// Sagawa serves both the list and the article body as XML, and the canonical
// article URL is derivable from i_id alone. link_url is therefore treated as a
// consistency check rather than as the source of the URL.
function isCanonicalArticleUrl(linkUrl: string, canonicalUrl: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, "");
  return normalize(linkUrl) === normalize(canonicalUrl);
}

export function parseSagawaArticleList(xml: string): SagawaArticleSummary[] {
  const summaries: SagawaArticleSummary[] = [];

  for (const match of xml.matchAll(/<information>([\s\S]*?)<\/information>/gi)) {
    const entry = match[1];
    const id = readPlainField(entry, "i_id");
    const publishedAt = readPublishedAt(entry);
    const title = readPlainField(entry, "title");
    const linkUrl = readPlainField(entry, "link_url");
    if (id === null || !/^\d+$/.test(id)) continue;
    if (publishedAt === null) continue;
    if (title === null || linkUrl === null) continue;

    const url = articlePageUrl(id);
    if (!isCanonicalArticleUrl(linkUrl, url)) continue;

    summaries.push({ id, url, title, publishedAt });
  }

  if (summaries.length === 0) {
    // An empty list would overwrite stored restrictions, so a layout change must
    // fail loudly instead of being mistaken for "no current articles".
    throw new Error(
      `Sagawa article list contained no parseable entries. Diagnostic excerpt: ${diagnosticExcerpt(xml)}`,
    );
  }

  return summaries;
}

export function parseSagawaArticleBody(xml: string, url: string): SourceDocument {
  const news = readElement(xml, "news");
  if (news === null) {
    throw new Error(
      `Sagawa article body was not found for ${url}. Diagnostic excerpt: ${diagnosticExcerpt(xml)}`,
    );
  }

  const text = htmlToStructuredText(stripCdata(news));
  if (text.length === 0) {
    throw new Error(
      `Sagawa article body was empty for ${url}. Diagnostic excerpt: ${diagnosticExcerpt(xml)}`,
    );
  }

  const title = readPlainField(xml, "title");
  const publishedAt = readPublishedAt(xml);

  return {
    carrier: "sagawa",
    url,
    title: title ?? undefined,
    text,
    publishedAt,
  };
}

/**
 * The standing status article, お荷物の集配および営業所の営業状況. Unlike the
 * event notices around it, it lists every area currently affected as of a
 * stated time, and Sagawa folds earlier event notices into it.
 */
const CONSOLIDATED_STATUS_TITLE = /集配および営業所の営業状況/;

export interface SagawaArticleSelection {
  /** Articles to read: the consolidated article and every notice not older than it. */
  current: SagawaArticleSummary[];
  /** The consolidated status article, or null when the list has none. */
  consolidated: SagawaArticleSummary | null;
  /** Notices published before the consolidated article, already reflected in it. */
  superseded: SagawaArticleSummary[];
}

/**
 * Drops the notices the consolidated status article has already absorbed.
 *
 * Reading every listed article double-counts an area that both an old event
 * notice and the consolidated article name (with different service or reason
 * wording, so deduplication does not merge them), and keeps an area alive for
 * as long as an outdated notice stays listed. A notice dated after the
 * consolidated article is kept: Sagawa may publish one before updating the
 * consolidated list. A notice from the same day is kept as well, since the
 * list carries dates without times. Without a consolidated article every
 * article is read, as before.
 */
export function selectCurrentSagawaArticles(articles: SagawaArticleSummary[]): SagawaArticleSelection {
  const consolidated = articles
    .filter(({ title }) => CONSOLIDATED_STATUS_TITLE.test(title))
    .reduce<SagawaArticleSummary | null>(
      (latest, article) => (latest === null || article.publishedAt > latest.publishedAt ? article : latest),
      null,
    );
  if (consolidated === null) return { current: articles, consolidated: null, superseded: [] };

  const current: SagawaArticleSummary[] = [];
  const superseded: SagawaArticleSummary[] = [];
  for (const article of articles) {
    if (article === consolidated || article.publishedAt >= consolidated.publishedAt) {
      current.push(article);
    } else {
      superseded.push(article);
    }
  }
  return { current, consolidated, superseded };
}

export async function fetchSagawaArticleList(): Promise<SagawaArticleSummary[]> {
  const response = await fetch(SAGAWA_ARTICLE_LIST_XML_URL, {
    headers: { "user-agent": "delivery-status-api/0.1" },
  });

  if (!response.ok) throw new Error(`Sagawa article list fetch failed: ${await describeHttpFailure(response)}`);

  return parseSagawaArticleList(await response.text());
}

export async function fetchSagawaArticle(summary: SagawaArticleSummary): Promise<SourceDocument> {
  const response = await fetch(articleXmlUrl(summary.id), {
    headers: { "user-agent": "delivery-status-api/0.1" },
  });

  if (!response.ok) {
    throw new Error(`Sagawa article fetch failed (${summary.url}): ${await describeHttpFailure(response)}`);
  }

  const document = parseSagawaArticleBody(await response.text(), summary.url);

  // The list entry is the authoritative publication metadata: the body XML may
  // omit it, and the article fingerprint is built from the list values.
  return {
    ...document,
    title: document.title ?? summary.title,
    publishedAt: document.publishedAt ?? summary.publishedAt,
  };
}
