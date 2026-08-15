import type { Carrier } from "../../src/types/restriction.ts";

export interface StoredSourceState {
  carrier: Carrier;
  fingerprint: string;
  source_urls_json: string;
  last_checked_at: string;
  last_changed_at: string;
}

interface PreparedStatement {
  sql: string;
  values: unknown[];
  bind(...values: unknown[]): PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface StoredSourceArticle {
  carrier: Carrier;
  source_url: string;
  fingerprint: string;
  title: string;
  source_updated_at: string | null;
  restrictions_json: string;
  extractor_version: string;
  last_seen_at: string;
}

export function createInMemoryD1(options: {
  counts?: Partial<Record<Carrier, number>>;
  states?: Partial<Record<Carrier, StoredSourceState>>;
  articles?: StoredSourceArticle[];
} = {}) {
  const counts: Record<Carrier, number> = {
    yamato: options.counts?.yamato ?? 0,
    sagawa: options.counts?.sagawa ?? 0,
    japan_post: options.counts?.japan_post ?? 0,
  };
  const states = new Map<Carrier, StoredSourceState>(
    Object.values(options.states ?? {}).filter((state): state is StoredSourceState => state !== undefined)
      .map((state) => [state.carrier, { ...state }]),
  );
  const articles = new Map<string, StoredSourceArticle>(
    (options.articles ?? []).map((article) => [`${article.carrier}|${article.source_url}`, { ...article }]),
  );
  const batches: PreparedStatement[][] = [];
  const runs: PreparedStatement[] = [];
  let failNextBatch: Error | null = null;

  const executeStateUpsert = (statement: PreparedStatement): void => {
    const [carrierValue, fingerprintValue, sourceUrlsValue, checkedAtValue] = statement.values;
    const carrier = carrierValue as Carrier;
    const checkedAt = String(checkedAtValue);
    const previous = states.get(carrier);
    states.set(carrier, {
      carrier,
      fingerprint: String(fingerprintValue),
      source_urls_json: String(sourceUrlsValue),
      last_checked_at: checkedAt,
      last_changed_at: previous !== undefined && previous.fingerprint === fingerprintValue
        ? previous.last_changed_at
        : checkedAt,
    });
  };

  const prepare = (sql: string): PreparedStatement => {
    const statement: PreparedStatement = {
      sql,
      values: [],
      bind(...values: unknown[]) {
        statement.values = values;
        return statement;
      },
      async first<T>() {
        const carrier = statement.values[0] as Carrier;
        if (/SELECT\s+COUNT\(\*\)/i.test(statement.sql)) {
          return { count: counts[carrier] } as T;
        }
        if (/FROM\s+carrier_source_states/i.test(statement.sql)) {
          return (states.get(carrier) ?? null) as T | null;
        }
        throw new Error(`Unsupported first SQL: ${statement.sql}`);
      },
      async all<T>() {
        if (/FROM\s+carrier_source_articles/i.test(statement.sql)) {
          const carrier = statement.values[0] as Carrier;
          return {
            results: [...articles.values()]
              .filter((article) => article.carrier === carrier)
              .sort((a, b) => a.source_url.localeCompare(b.source_url)) as T[],
          };
        }
        throw new Error(`Unsupported all SQL: ${statement.sql}`);
      },
      async run() {
        runs.push(statement);
        if (/INSERT\s+INTO\s+carrier_source_states/i.test(statement.sql)) {
          executeStateUpsert(statement);
          return {};
        }
        throw new Error(`Unsupported run SQL: ${statement.sql}`);
      },
    };
    return statement;
  };

  const db = {
    prepare,
    async batch(statements: PreparedStatement[]) {
      batches.push(statements);
      if (failNextBatch !== null) {
        const failure = failNextBatch;
        failNextBatch = null;
        throw failure;
      }

      const deletedCarriers = statements
        .filter((statement) => /DELETE\s+FROM\s+delivery_restrictions/i.test(statement.sql))
        .map((statement) => statement.values[0] as Carrier);
      for (const carrier of deletedCarriers) {
        counts[carrier] = statements.filter((statement) =>
          /INSERT\s+INTO\s+delivery_restrictions/i.test(statement.sql)
          && statement.values[0] === carrier
        ).length;
      }
      for (const statement of statements) {
        if (/INSERT\s+INTO\s+carrier_source_states/i.test(statement.sql)) {
          executeStateUpsert(statement);
        }
      }
      for (const statement of statements) {
        if (/DELETE\s+FROM\s+carrier_source_articles/i.test(statement.sql)) {
          const carrier = statement.values[0] as Carrier;
          for (const [key, article] of articles) {
            if (article.carrier === carrier) articles.delete(key);
          }
        }
        if (/INSERT\s+INTO\s+carrier_source_articles/i.test(statement.sql)) {
          const [carrierValue, sourceUrl, fingerprint, title, updatedAt, restrictionsJson, extractorVersion, lastSeenAt] = statement.values;
          const carrier = carrierValue as Carrier;
          const article: StoredSourceArticle = {
            carrier,
            source_url: String(sourceUrl),
            fingerprint: String(fingerprint),
            title: String(title),
            source_updated_at: updatedAt === null ? null : String(updatedAt),
            restrictions_json: String(restrictionsJson),
            extractor_version: String(extractorVersion),
            last_seen_at: String(lastSeenAt),
          };
          articles.set(`${carrier}|${article.source_url}`, article);
        }
      }
      return [];
    },
  };

  return {
    db: db as unknown as D1Database,
    counts,
    states,
    articles,
    batches,
    runs,
    failOnce(error = new Error("simulated atomic batch failure")) {
      failNextBatch = error;
    },
  };
}

export function sourceState(
  carrier: Carrier,
  fingerprint: string,
  lastCheckedAt: string,
  sourceUrls: string[] = [],
): StoredSourceState {
  return {
    carrier,
    fingerprint,
    source_urls_json: JSON.stringify(sourceUrls),
    last_checked_at: lastCheckedAt,
    last_changed_at: lastCheckedAt,
  };
}
