import type { SourceDocument } from "../types/restriction";

const YAMATO_STATUS_URL = "https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html";

export async function fetchYamatoStatus(): Promise<SourceDocument> {
  const response = await fetch(YAMATO_STATUS_URL, {
    headers: { "user-agent": "delivery-status-api/0.1" },
  });

  if (!response.ok) throw new Error(`Yamato fetch failed: ${response.status}`);

  return {
    carrier: "yamato",
    url: YAMATO_STATUS_URL,
    text: await response.text(),
  };
}
