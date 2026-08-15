import {
  deduplicateRestrictions,
  EXTRACTOR_VERSION,
  extractRestrictions,
  extractRestrictionsFromPdf,
  type JapanPostExtractionResult,
} from "./ai/terra";
import {
  fetchSagawaArticle,
  fetchSagawaArticleList,
  type SagawaArticleSummary,
} from "./scrapers/sagawa";
import { fetchYamatoStatus, yamatoFingerprintText } from "./scrapers/yamato";
import { sha256Hex } from "./source-fingerprint";
import {
  countCarrierRestrictions,
  replaceCarrierRestrictionsAndState,
  replaceCarrierRestrictionsStateAndArticles,
} from "./storage/restrictions";
import {
  listCarrierSourceArticles,
  type CarrierSourceArticle,
} from "./storage/source-articles";
import { getCarrierSourceState, touchCarrierSourceState } from "./storage/source-states";
import { checkedToday } from "./tokyo-day";
import type { Carrier, DeliveryRestriction, SourceDocument } from "./types/restriction";

export interface SyncEnv {
  DB: D1Database;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
}

export interface CarrierSyncFailure {
  carrier: Carrier;
  phase: "fetch" | "extract" | "research" | "store";
  message: string;
  sourceUrl?: string;
}

export class SyncError extends Error {
  constructor(
    public readonly counts: Record<Carrier, number>,
    public readonly failures: CarrierSyncFailure[],
  ) {
    super(`Delivery status sync failed for ${[...new Set(failures.map(({ carrier }) => carrier))].join(", ")}`);
    this.name = "SyncError";
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function sourceTitleForLog(source: SourceDocument): string {
  if (!source.title) return "(none)";
  return source.title.replace(/\s+/g, " ").trim().slice(0, 160) || "(none)";
}

async function storeCarrierRestrictions(
  env: SyncEnv,
  carrier: Carrier,
  restrictions: DeliveryRestriction[],
  counts: Record<Carrier, number>,
  failures: CarrierSyncFailure[],
  fingerprint: string,
  sourceUrls: string[],
  checkedAt: string,
): Promise<void> {
  try {
    await replaceCarrierRestrictionsAndState(
      env.DB,
      carrier,
      restrictions,
      fingerprint,
      sourceUrls,
      checkedAt,
    );
    counts[carrier] = restrictions.length;
  } catch (reason) {
    const failure = { carrier, phase: "store" as const, message: errorMessage(reason) };
    failures.push(failure);
    console.error(`[sync] ${carrier} store failed: ${failure.message}`);
  }
}

async function syncYamato(
  env: SyncEnv,
  counts: Record<Carrier, number>,
  failures: CarrierSyncFailure[],
): Promise<void> {
  const now = new Date();
  const previousState = await getCarrierSourceState(env.DB, "yamato");
  // v3: the fingerprint stopped covering Yamato's hourly "…時現在" stamp, so
  // hashes stored under the v2 scheme must never compare equal to new ones.
  const versionPrefix = `yamato:v3:rules=${EXTRACTOR_VERSION}:model=${env.OPENAI_MODEL}:`;
  if (
    previousState !== null
    && previousState.fingerprint.startsWith(versionPrefix)
    && checkedToday(previousState.lastCheckedAt, now)
  ) {
    console.info(`[sync] yamato: already checked today; reused=${counts.yamato}`);
    return;
  }
  let source: SourceDocument;
  try {
    source = await fetchYamatoStatus();
  } catch (reason) {
    const failure = { carrier: "yamato" as const, phase: "fetch" as const, message: errorMessage(reason) };
    failures.push(failure);
    console.error(`[sync] yamato fetch failed: ${failure.message}`);
    return;
  }

  console.info("[sync] yamato: loaded 1 source(s)");
  console.info(
    `[sync] yamato: source[0] kind=primary url=${source.url} title=${JSON.stringify(sourceTitleForLog(source))} textChars=${source.text.length}`,
  );

  const checkedAt = now.toISOString();
  // Hashed text and model input differ on purpose: yamatoFingerprintText drops
  // the page's own hourly timestamp lines, which otherwise churn the
  // fingerprint on every run and defeat the "unchanged -> skip the model"
  // branch below. source.text keeps them, so the model still sees them.
  const fingerprint = `${versionPrefix}${await sha256Hex(yamatoFingerprintText(source.text))}`;
  if (previousState?.fingerprint === fingerprint) {
    await touchCarrierSourceState(env.DB, previousState, checkedAt, [source.url]);
    counts.yamato = await countCarrierRestrictions(env.DB, "yamato");
    console.info(`[sync] yamato: unchanged; reused=${counts.yamato}`);
    return;
  }

  let restrictions: DeliveryRestriction[];
  try {
    restrictions = deduplicateRestrictions(
      await extractRestrictions(source, env.OPENAI_API_KEY, env.OPENAI_MODEL),
    );
  } catch (reason) {
    const failure = {
      carrier: "yamato" as const,
      phase: "extract" as const,
      sourceUrl: source.url,
      message: errorMessage(reason),
    };
    failures.push(failure);
    console.error(`[sync] yamato extraction failed (${source.url}): ${failure.message}`);
    return;
  }

  console.info(`[sync] yamato: extracted=${restrictions.length}`);
  if (restrictions.length === 0) {
    // Direct page extraction has no explicit, evidence-backed "none active"
    // determination, so it cannot safely authorize destructive replacement.
    console.warn("[sync] yamato: extraction returned zero restrictions; preserving existing data");
    return;
  }

  await storeCarrierRestrictions(
    env,
    "yamato",
    restrictions,
    counts,
    failures,
    fingerprint,
    [source.url],
    checkedAt,
  );
}

const JAPAN_POST_STATUS_URL = "https://www.post.japanpost.jp/assets/docs/service/unkou.pdf";

/**
 * Downloads the official PDF once. The bytes are both hashed for the change
 * check and handed to the model, so a changed document is never fetched twice.
 */
export async function fetchJapanPostFingerprint(): Promise<{
  fingerprint: string;
  sourceUrl: string;
  pdf: ArrayBuffer;
}> {
  const response = await fetch(JAPAN_POST_STATUS_URL, {
    headers: { "user-agent": "delivery-status-api/0.1" },
  });
  if (!response.ok) throw new Error(`Japan Post probe failed: ${response.status}`);
  const bytes = await response.arrayBuffer();
  return {
    fingerprint: `japan-post-pdf:v1:${await sha256Hex(bytes)}`,
    sourceUrl: JAPAN_POST_STATUS_URL,
    pdf: bytes,
  };
}

async function syncJapanPost(
  env: SyncEnv,
  counts: Record<Carrier, number>,
  failures: CarrierSyncFailure[],
): Promise<void> {
  const now = new Date();
  const previousState = await getCarrierSourceState(env.DB, "japan_post");
  // pdf-v1: the official PDF is now attached to the extraction call instead of
  // being looked up with a search tool, and the model that reads it is
  // OPENAI_MODEL rather than the removed research-model variable. Fingerprints
  // stored under the research scheme must never compare equal to new ones.
  const versionPrefix = `japan-post:pdf-v1:rules=${EXTRACTOR_VERSION}:model=${env.OPENAI_MODEL}:pdfsha=`;
  if (
    previousState !== null
    && previousState.fingerprint.startsWith(versionPrefix)
    && checkedToday(previousState.lastCheckedAt, now)
  ) {
    console.info(`[sync] japan_post: already checked today; reused=${counts.japan_post}`);
    return;
  }
  const checkedAt = now.toISOString();
  let probe: Awaited<ReturnType<typeof fetchJapanPostFingerprint>>;
  try {
    probe = await fetchJapanPostFingerprint();
  } catch (reason) {
    const failure = { carrier: "japan_post" as const, phase: "fetch" as const, message: errorMessage(reason) };
    failures.push(failure);
    console.error(`[sync] japan_post probe failed: ${failure.message}`);
    return;
  }
  const effectiveFingerprint = `${versionPrefix}${probe.fingerprint}`;
  if (previousState?.fingerprint === effectiveFingerprint) {
    await touchCarrierSourceState(env.DB, previousState, checkedAt, [probe.sourceUrl]);
    counts.japan_post = await countCarrierRestrictions(env.DB, "japan_post");
    console.info(`[sync] japan_post: unchanged; reused=${counts.japan_post}`);
    return;
  }

  let result: JapanPostExtractionResult;
  try {
    result = await extractRestrictionsFromPdf(
      { carrier: "japan_post", url: probe.sourceUrl },
      probe.pdf,
      env.OPENAI_API_KEY,
      env.OPENAI_MODEL,
    );
  } catch (reason) {
    // Covers an unreadable document and any determination that contradicts the
    // records returned with it: both throw, so the existing rows are kept.
    const failure = {
      carrier: "japan_post" as const,
      phase: "extract" as const,
      sourceUrl: probe.sourceUrl,
      message: errorMessage(reason),
    };
    failures.push(failure);
    console.error(`[sync] japan_post extraction failed (${probe.sourceUrl}): ${failure.message}`);
    return;
  }

  console.info(
    `[sync] japan_post: determination=${result.determination} restrictions=${result.restrictions.length}`,
  );
  // A confirmed no_active_restrictions result deliberately stores an empty set:
  // unlike Yamato's page extraction, the attached PDF is the authoritative full
  // document and was read end to end, so "none active" is a real determination.
  await storeCarrierRestrictions(
    env,
    "japan_post",
    deduplicateRestrictions(result.restrictions),
    counts,
    failures,
    effectiveFingerprint,
    [probe.sourceUrl],
    checkedAt,
  );
}

// The XML endpoints backing the article list and bodies are an implementation
// detail; only the user-facing pages are persisted and exposed by the API.
const SAGAWA_INFORMATION_LIST_URL = "https://www2.sagawa-exp.co.jp/information/list/";

async function syncSagawa(
  env: SyncEnv,
  counts: Record<Carrier, number>,
  failures: CarrierSyncFailure[],
): Promise<void> {
  const now = new Date();
  const previousState = await getCarrierSourceState(env.DB, "sagawa");
  const extractorVersion = `sagawa-xml-v1:rules=${EXTRACTOR_VERSION}:model=${env.OPENAI_MODEL}`;
  const versionPrefix = `sagawa:xml-v1:rules=${EXTRACTOR_VERSION}:model=${env.OPENAI_MODEL}:`;
  if (
    previousState !== null
    && previousState.fingerprint.startsWith(versionPrefix)
    && checkedToday(previousState.lastCheckedAt, now)
  ) {
    console.info(`[sync] sagawa: already checked today; reused=${counts.sagawa}`);
    return;
  }
  const checkedAt = now.toISOString();
  let articles: SagawaArticleSummary[];
  try {
    articles = await fetchSagawaArticleList();
  } catch (reason) {
    const failure = { carrier: "sagawa" as const, phase: "fetch" as const, message: errorMessage(reason) };
    failures.push(failure);
    console.error(`[sync] sagawa article list fetch failed: ${failure.message}`);
    return;
  }
  let cachedArticles: CarrierSourceArticle[];
  try {
    cachedArticles = await listCarrierSourceArticles(env.DB, "sagawa");
  } catch (reason) {
    const failure = { carrier: "sagawa" as const, phase: "store" as const, message: errorMessage(reason) };
    failures.push(failure);
    console.error(`[sync] sagawa article cache read failed: ${failure.message}`);
    return;
  }
  const cachedByUrl = new Map(cachedArticles.map((article) => [article.sourceUrl, article]));
  const currentArticles: CarrierSourceArticle[] = [];
  let extractedArticles = 0;

  for (const article of articles) {
    // The official XML carries the publication date, so this fingerprint is
    // stable across runs and only moves when the article itself changes.
    const articleFingerprint = await sha256Hex(JSON.stringify({
      url: article.url,
      title: article.title,
      publishedAt: article.publishedAt,
    }));
    const cached = cachedByUrl.get(article.url);
    let articleRestrictions: DeliveryRestriction[];

    if (
      cached?.fingerprint === articleFingerprint
      && cached.extractorVersion === extractorVersion
    ) {
      articleRestrictions = cached.restrictions.map((restriction) => ({
        ...restriction,
        carrier: "sagawa",
        sourceUrl: article.url,
        checkedAt,
      }));
    } else {
      let document: SourceDocument;
      try {
        document = await fetchSagawaArticle(article);
      } catch (reason) {
        const failure = {
          carrier: "sagawa" as const,
          phase: "fetch" as const,
          sourceUrl: article.url,
          message: errorMessage(reason),
        };
        failures.push(failure);
        console.error(`[sync] sagawa article fetch failed (${article.url}): ${failure.message}`);
        return;
      }

      try {
        const extracted = await extractRestrictions(document, env.OPENAI_API_KEY, env.OPENAI_MODEL);
        articleRestrictions = extracted.map((restriction) => ({
          ...restriction,
          sourceUrl: article.url,
          checkedAt,
        }));
        extractedArticles += 1;
      } catch (reason) {
        const failure = {
          carrier: "sagawa" as const,
          phase: "research" as const,
          sourceUrl: article.url,
          message: errorMessage(reason),
        };
        failures.push(failure);
        console.error(`[sync] sagawa article extraction failed (${article.url}): ${failure.message}`);
        return;
      }
    }

    currentArticles.push({
      carrier: "sagawa",
      sourceUrl: article.url,
      fingerprint: articleFingerprint,
      title: article.title,
      sourceUpdatedAt: article.publishedAt,
      restrictions: articleRestrictions,
      extractorVersion,
      lastSeenAt: checkedAt,
    });
  }

  // Unlike Yamato, an empty result here is authoritative: the official list is
  // the complete set of current articles and every one of them was read, so
  // "no active restrictions" is a real determination and is stored as such.
  const restrictions = deduplicateRestrictions(
    currentArticles.flatMap(({ restrictions: articleRestrictions }) => articleRestrictions),
  );
  const fingerprint = `${versionPrefix}${await sha256Hex(JSON.stringify(
    currentArticles.map(({ sourceUrl, fingerprint: articleFingerprint }) => ({
      sourceUrl,
      fingerprint: articleFingerprint,
    })),
  ))}`;

  try {
    await replaceCarrierRestrictionsStateAndArticles(
      env.DB,
      "sagawa",
      restrictions,
      fingerprint,
      [SAGAWA_INFORMATION_LIST_URL, ...articles.map(({ url }) => url)],
      checkedAt,
      currentArticles,
    );
    counts.sagawa = restrictions.length;
    console.info(
      `[sync] sagawa: articles=${currentArticles.length} researched=${extractedArticles} reused=${currentArticles.length - extractedArticles} restrictions=${restrictions.length}`,
    );
  } catch (reason) {
    const failure = { carrier: "sagawa" as const, phase: "store" as const, message: errorMessage(reason) };
    failures.push(failure);
    console.error(`[sync] sagawa store failed: ${failure.message}`);
  }
}

export async function syncAll(env: SyncEnv): Promise<Record<Carrier, number>> {
  const counts: Record<Carrier, number> = {
    yamato: await countCarrierRestrictions(env.DB, "yamato"),
    sagawa: await countCarrierRestrictions(env.DB, "sagawa"),
    japan_post: await countCarrierRestrictions(env.DB, "japan_post"),
  };
  const failures: CarrierSyncFailure[] = [];

  await syncYamato(env, counts, failures);

  // Keep external calls sequential to avoid avoidable API bursts.
  await syncSagawa(env, counts, failures);
  await syncJapanPost(env, counts, failures);

  if (failures.length > 0) throw new SyncError(counts, failures);
  return counts;
}
