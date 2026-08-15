import type { SourceDocument } from "../types/restriction";

const SAGAWA_NEWS_URL = "https://www2.sagawa-exp.co.jp/information/list/";

export interface BrowserBinding {
  quickAction(action: string, input: Record<string, unknown>): Promise<unknown>;
}

export async function fetchSagawaStatus(browser: BrowserBinding): Promise<SourceDocument> {
  const rendered = await browser.quickAction("markdown", { url: SAGAWA_NEWS_URL });

  return {
    carrier: "sagawa",
    url: SAGAWA_NEWS_URL,
    text: typeof rendered === "string" ? rendered : JSON.stringify(rendered),
  };
}
