import { decodeHtmlEntities } from "./scrapers/html";

/**
 * Response headers that identify who refused a request: the origin, a CDN, or
 * a WAF / bot-management layer in front of it. A bare status code cannot tell
 * those apart, and the failure is only seen after the fact (daily report,
 * Workers Logs), so whatever identifies the blocker has to be captured here.
 */
const DIAGNOSTIC_HEADERS = [
  "server",
  "via",
  "content-type",
  "location",
  "retry-after",
  "x-cache",
  "cf-ray",
  "cf-mitigated",
  "cf-cache-status",
  "akamai-grn",
  "x-akamai-request-id",
  "x-reference-error",
  "x-amz-cf-id",
  "x-amz-cf-pop",
  "x-amzn-waf-action",
  "x-amzn-requestid",
  "x-iinfo",
  "x-cdn",
] as const;

/** Bytes of the body read for the snippet; error pages put their reason near the top. */
const BODY_READ_LIMIT = 16 * 1024;
/** Characters of the cleaned body kept in the message, which ends up in a chat post. */
const BODY_SNIPPET_LIMIT = 300;
const HEADER_VALUE_LIMIT = 120;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

async function readBodyPrefix(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < BODY_READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Stop the rest of the body from being downloaded; failure to cancel is moot.
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(total, BODY_READ_LIMIT));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Reduces an HTML or plain-text error body to one readable line. */
export function summarizeErrorBody(body: string): string {
  const text = decodeHtmlEntities(
    body
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(text, BODY_SNIPPET_LIMIT);
}

/**
 * Describes a non-OK response for an error message: status, the headers that
 * identify the refusing layer, and the start of the body, e.g.
 *
 *   403 Forbidden [server=AkamaiGHost; akamai-grn=0.1a2b...] body="Access Denied You don't have permission ... Reference #18.1a2b..."
 *
 * Consumes the response body.
 */
export async function describeHttpFailure(response: Response): Promise<string> {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

  const headers = DIAGNOSTIC_HEADERS.flatMap((name) => {
    const value = response.headers.get(name);
    return value ? [`${name}=${truncate(value, HEADER_VALUE_LIMIT)}`] : [];
  });

  let body = "";
  try {
    body = summarizeErrorBody(await readBodyPrefix(response));
  } catch (reason) {
    body = `<unreadable: ${reason instanceof Error ? reason.message : String(reason)}>`;
  }

  return [
    status,
    headers.length > 0 ? `[${headers.join("; ")}]` : null,
    body ? `body=${JSON.stringify(body)}` : null,
  ].filter(Boolean).join(" ");
}
