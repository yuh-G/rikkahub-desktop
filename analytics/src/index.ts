import { handlePing, refreshDailySummary, rebuildAll } from "./ping";
import { dashboardHtml } from "../dashboard/template";
import { getStats } from "./stats";

export interface Env {
  DB: D1Database;
  AUTH_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS for all routes
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    // ── Ping (client上报) ──────────────────────────────────────────
    if (path === "/ping" && request.method === "GET") {
      return handlePing(url, env);
    }

    // ── Internal: cron-triggered daily summary refresh ─────────────
    if (path === "/internal/refresh" && request.method === "POST") {
      const auth = url.searchParams.get("token");
      if (auth !== env.AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const result = await refreshDailySummary(env);
      return new Response(JSON.stringify(result), { headers });
    }

    // ── Internal: one-time rebuild of first_seen + aggregates ───────
    if (path === "/internal/rebuild" && request.method === "POST") {
      const auth = url.searchParams.get("token");
      if (auth !== env.AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const result = await rebuildAll(env);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers });
    }

    // ── Stats JSON API ─────────────────────────────────────────────
    if (path === "/api/stats" && request.method === "GET") {
      const auth = url.searchParams.get("token");
      if (auth !== env.AUTH_TOKEN) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers,
        });
      }
      const stats = await getStats(url, env);
      return new Response(JSON.stringify(stats), { headers });
    }

    // ── Dashboard HTML ─────────────────────────────────────────────
    if (path === "/dashboard") {
      const token = url.searchParams.get("token");
      if (token !== env.AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(dashboardHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  // Cron trigger: refresh today's summary every hour
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await refreshDailySummary(env);
  },
};
