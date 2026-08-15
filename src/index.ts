import { findActiveApiKey, touchApiKeyUsage } from "./storage/api-keys";
import { listRestrictions } from "./storage/restrictions";
import { SyncError, syncAll, type SyncEnv } from "./sync";
import type { Carrier } from "./types/restriction";

interface Env extends SyncEnv {
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

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncAll(env));
  },
};
