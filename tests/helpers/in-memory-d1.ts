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

export interface StoredApiKey {
  id: number;
  name: string;
  key_hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface StoredRestrictionRow {
  carrier: Carrier;
  prefecture: string;
  city: string | null;
  area: string | null;
  status: string;
  services_json: string;
  reason: string | null;
  source_url: string;
  source_published_at: string | null;
  checked_at: string;
}

export function createInMemoryD1(options: {
  counts?: Partial<Record<Carrier, number>>;
  states?: Partial<Record<Carrier, StoredSourceState>>;
  articles?: StoredSourceArticle[];
  apiKeys?: StoredApiKey[];
  restrictions?: StoredRestrictionRow[];
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
  const apiKeys = new Map<number, StoredApiKey>(
    (options.apiKeys ?? []).map((apiKey) => [apiKey.id, { ...apiKey }]),
  );
  const restrictionRows = (options.restrictions ?? []).map((row) => ({ ...row }));
  const batches: PreparedStatement[][] = [];
  const runs: PreparedStatement[] = [];
  let failNextBatch: Error | null = null;
  let failNextApiKeyLookup: Error | null = null;
  let apiKeyUsageWrites = 0;

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
        if (/FROM\s+api_keys/i.test(statement.sql)) {
          if (failNextApiKeyLookup !== null) {
            const failure = failNextApiKeyLookup;
            failNextApiKeyLookup = null;
            throw failure;
          }
          const keyHash = String(statement.values[0]);
          // Mirrors the SQL: a revoked row is simply not found.
          const found = [...apiKeys.values()].find(
            (apiKey) => apiKey.key_hash === keyHash && apiKey.revoked_at === null,
          );
          return (found === undefined ? null : { id: found.id, name: found.name }) as T | null;
        }
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
        if (/FROM\s+delivery_restrictions/i.test(statement.sql)) {
          const carrier = statement.values[0] as Carrier | undefined;
          return {
            results: restrictionRows.filter(
              (row) => carrier === undefined || row.carrier === carrier,
            ) as T[],
          };
        }
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
        if (/UPDATE\s+api_keys/i.test(statement.sql)) {
          const [usedAt, id, dayStart] = statement.values;
          const apiKey = apiKeys.get(Number(id));
          // Mirrors the guarded WHERE clause: nothing is written when the key
          // was already recorded during the current Tokyo calendar day.
          if (
            apiKey !== undefined
            && (apiKey.last_used_at === null || apiKey.last_used_at < String(dayStart))
          ) {
            apiKey.last_used_at = String(usedAt);
            apiKeyUsageWrites += 1;
          }
          return {};
        }
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
    apiKeys,
    batches,
    runs,
    apiKeyUsageWrites: () => apiKeyUsageWrites,
    failOnce(error = new Error("simulated atomic batch failure")) {
      failNextBatch = error;
    },
    failApiKeyLookupOnce(error = new Error("simulated D1 lookup failure")) {
      failNextApiKeyLookup = error;
    },
  };
}

export function storedApiKey(
  id: number,
  name: string,
  keyHash: string,
  overrides: Partial<StoredApiKey> = {},
): StoredApiKey {
  return {
    id,
    name,
    key_hash: keyHash,
    created_at: "2026-08-01 00:00:00",
    revoked_at: null,
    last_used_at: null,
    ...overrides,
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
