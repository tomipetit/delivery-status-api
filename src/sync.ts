import { extractRestrictions } from "./ai/terra";
import { fetchJapanPostStatus } from "./scrapers/japan-post";
import { fetchSagawaStatus, type BrowserBinding } from "./scrapers/sagawa";
import { fetchYamatoStatus } from "./scrapers/yamato";
import { replaceCarrierRestrictions } from "./storage/restrictions";
import type { Carrier, SourceDocument } from "./types/restriction";

export interface SyncEnv {
  DB: D1Database;
  BROWSER: BrowserBinding;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
}

export async function syncAll(env: SyncEnv): Promise<Record<Carrier, number>> {
  const sources: SourceDocument[] = await Promise.all([
    fetchYamatoStatus(),
    fetchSagawaStatus(env.BROWSER),
    fetchJapanPostStatus(),
  ]);

  const counts: Record<Carrier, number> = {
    yamato: 0,
    sagawa: 0,
    japan_post: 0,
  };

  for (const source of sources) {
    const restrictions = await extractRestrictions(
      source,
      env.OPENAI_API_KEY,
      env.OPENAI_MODEL,
    );

    await replaceCarrierRestrictions(env.DB, source.carrier, restrictions);
    counts[source.carrier] = restrictions.length;
  }

  return counts;
}
