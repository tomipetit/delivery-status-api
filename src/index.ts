import { listRestrictions } from "./storage/restrictions";
import { SyncError, syncAll, type SyncEnv } from "./sync";
import type { Carrier } from "./types/restriction";

interface Env extends SyncEnv {
  API_KEY: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  return authorization === `Bearer ${env.API_KEY}`;
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

    if (!isAuthorized(request, env)) {
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
