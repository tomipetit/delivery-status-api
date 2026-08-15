import type { SourceDocument } from "../types/restriction";

const JAPAN_POST_NEWS_URL = "https://www.post.japanpost.jp/newsrelease/";

export async function fetchJapanPostStatus(): Promise<SourceDocument> {
  const response = await fetch(JAPAN_POST_NEWS_URL, {
    headers: { "user-agent": "delivery-status-api/0.1" },
  });

  if (!response.ok) throw new Error(`Japan Post fetch failed: ${response.status}`);

  return {
    carrier: "japan_post",
    url: JAPAN_POST_NEWS_URL,
    text: await response.text(),
  };
}
