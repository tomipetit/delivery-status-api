import { sendUsageReport, type UsageReportEnv } from "./notify/usage-report";
import { refreshPostalCodes } from "./postal/refresh";
import { findActiveApiKey, touchApiKeyUsage } from "./storage/api-keys";
import { listRestrictions } from "./storage/restrictions";
import { SyncError, syncAll, type CarrierSyncFailure, type SyncEnv } from "./sync";
import { tokyoPreviousCalendarDate } from "./tokyo-day";
import type { Carrier } from "./types/restriction";

interface Env extends SyncEnv, UsageReportEnv {
  API_KEY: string;
}

/**
 * Who a request is acting as. The admin key (env.API_KEY) reaches every route
 * and is the bootstrap path before any client key exists — or after every one
 * of them has been revoked. Client keys live in D1 and are read-only.
 */
type Principal = { kind: "admin" } | { kind: "client"; id: number; name: string };

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Resolves the presented credential to a principal, or null when the request is
 * not authenticated. Nothing here ever logs the presented key.
 */
async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const presented = bearerToken(request);
  if (presented === null) return null;

  if (typeof env.API_KEY === "string" && env.API_KEY.length > 0 && presented === env.API_KEY) {
    return { kind: "admin" };
  }

  let client: Awaited<ReturnType<typeof findActiveApiKey>>;
  try {
    client = await findActiveApiKey(env.DB, presented);
  } catch (reason) {
    // A storage failure is not permission to proceed: fail closed.
    console.error(`[auth] client key lookup failed: ${errorMessage(reason)}`);
    return null;
  }
  if (client === null) return null;

  try {
    await touchApiKeyUsage(env.DB, client.id, new Date());
  } catch (reason) {
    // last_used_at is diagnostic. Losing it must not revoke a valid key's access.
    console.warn(`[auth] usage bookkeeping failed for key #${client.id}: ${errorMessage(reason)}`);
  }

  return { kind: "client", id: client.id, name: client.name };
}

function parseCarrier(value: string | null): Carrier | undefined {
  if (value === "yamato" || value === "sagawa" || value === "japan_post") return value;
  return undefined;
}

/**
 * The monthly postal-code refresh trigger, matched against `controller.cron`.
 * Must stay identical to the second entry of `triggers.crons` in wrangler.jsonc.
 */
const POSTAL_REFRESH_CRON = "0 18 1 * *";

/**
 * Postal codes are an enrichment of data that is already correct without them,
 * so the monthly refresh is fully guarded: whatever it does, the stored
 * restrictions and the daily carrier sync are untouched by its failure.
 */
async function runPostalRefresh(env: Env): Promise<void> {
  try {
    const result = await refreshPostalCodes(env.DB);
    console.info(
      `[postal] ${result.yymm}: deleted=${result.deleted} added=${result.added}`
      + (result.missing.length > 0 ? ` missing=${result.missing.join(",")}` : ""),
    );
  } catch (reason) {
    console.error(`[postal] monthly refresh failed: ${errorMessage(reason)}`);
  }
}

/**
 * The daily job: sync, then report yesterday's spend.
 *
 * The report covers the previous Tokyo day rather than the current one because
 * that day is closed — a manual POST /api/v1/sync made after this run would
 * otherwise never appear in any report. It is sent whether or not the sync
 * succeeded, and a report that stops arriving means the cron itself stopped.
 */
async function runDailySync(env: Env): Promise<void> {
  let failures: readonly CarrierSyncFailure[] = [];
  let abortMessage: string | null = null;

  try {
    await syncAll(env);
  } catch (reason) {
    if (reason instanceof SyncError) {
      failures = reason.failures;
    } else {
      // Not a per-carrier failure: the run itself did not finish.
      abortMessage = errorMessage(reason);
      console.error(`[sync] daily run aborted: ${abortMessage}`);
    }
  }

  try {
    await sendUsageReport(env, tokyoPreviousCalendarDate(new Date()), { failures, abortMessage });
  } catch (reason) {
    // Reporting is observation, not the job: a notification failure must not be
    // able to take down the sync it is reporting on.
    console.error(`[usage-report] send failed: ${errorMessage(reason)}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    const principal = await authenticate(request, env);
    if (principal === null) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/restrictions") {
      const carrierParam = url.searchParams.get("carrier");
      const carrier = parseCarrier(carrierParam);

      if (carrierParam && !carrier) {
        return json({ error: "Invalid carrier" }, 400);
      }

      const restrictions = await listRestrictions(env.DB, carrier);
      return json({ data: restrictions, count: restrictions.length });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/sync") {
      // Sync spends OpenAI credit and reaches out to carrier sites, so it stays
      // with the admin key and is never reachable with a key given to a client.
      if (principal.kind !== "admin") {
        return json({ error: "Forbidden" }, 403);
      }

      try {
        const counts = await syncAll(env);
        return json({ ok: true, counts });
      } catch (error) {
        if (error instanceof SyncError) {
          return json({ ok: false, counts: error.counts, failures: error.failures }, 502);
        }
        throw error;
      }
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Two triggers, two jobs: the daily carrier sync and the monthly postal
    // refresh never run in the same invocation, so neither can delay or fail
    // the other.
    if (controller.cron === POSTAL_REFRESH_CRON) {
      ctx.waitUntil(runPostalRefresh(env));
      return;
    }
    ctx.waitUntil(runDailySync(env));
  },
};
