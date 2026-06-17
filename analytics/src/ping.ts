import type { Env } from "./index";

/**
 * GET /ping?id=<uuid>&v=<version>&os=<win|linux>&mc=<msg_count>&d=<YYYY-MM-DD>
 *
 * Upserts one row per (device_id, date). The msg_count is the cumulative total
 * for that day — the client tracks its own counter and sends the latest value.
 * first_seen is set to TRUE only on the device's very first appearance EVER
 * (checked against any prior row), NOT merely the first ping of a new date —
 * otherwise every active device per day would look "new" and SUM(first_seen)
 * would collapse into DAU.
 */
export async function handlePing(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get("id");
  const date = url.searchParams.get("d");
  const version = url.searchParams.get("v") ?? "";
  const os = url.searchParams.get("os") ?? "";
  const mc = parseInt(url.searchParams.get("mc") ?? "0", 10);

  // Basic validation
  if (!id || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-f0-9-]{20,64}$/.test(id)) {
    return new Response(JSON.stringify({ ok: false, error: "bad params" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const clampedMc = Math.max(0, Math.min(mc, 999999));

  try {
    // 设备是否首次出现?查它是否已有任意历史行;没有才是真正的新设备。
    const prior = await env.DB.prepare(
      `SELECT 1 FROM pings WHERE device_id = ? LIMIT 1`
    ).bind(id).first();
    const isNew = !prior;

    await env.DB.prepare(
      `INSERT INTO pings (device_id, date, version, os, msg_count, first_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, date) DO UPDATE SET
         version   = excluded.version,
         os        = excluded.os,
         msg_count = MAX(msg_count, excluded.msg_count)`
    ).bind(id, date, version, os, clampedMc, isNew ? 1 : 0).run();

    // Opportunistically refresh today's summary (fire-and-forget-ish, but we
    // await to keep the D1 write in the same request context for consistency).
    // This is cheap — one aggregation query — so doing it on every ping is fine
    // for a few thousand DAU. If scale grows, switch to cron-only refresh.
    await refreshDay(env, date);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    console.error("ping error:", err);
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

/**
 * Recompute daily_summary for a given date from raw pings.
 * Also recomputes version_dist for that date.
 */
export async function refreshDay(env: Env, date: string): Promise<void> {
  // Aggregate from pings
  const agg = await env.DB.prepare(
    `SELECT
       COUNT(*)                  AS dau,
       SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END) AS eff_dau,
       SUM(CASE WHEN first_seen THEN 1 ELSE 0 END)    AS new_users,
       SUM(msg_count)           AS total_msgs,
       SUM(CASE WHEN os = 'win' THEN 1 ELSE 0 END)    AS win_users,
       SUM(CASE WHEN os = 'linux' THEN 1 ELSE 0 END)  AS linux_users,
       SUM(CASE WHEN os = 'mac' THEN 1 ELSE 0 END)    AS mac_users
     FROM pings WHERE date = ?`
  ).bind(date).first<any>();

  if (!agg || agg.dau === 0) return;

  await env.DB.prepare(
    `INSERT INTO daily_summary (date, dau, eff_dau, new_users, total_msgs, win_users, linux_users, mac_users)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       dau = excluded.dau, eff_dau = excluded.eff_dau, new_users = excluded.new_users,
       total_msgs = excluded.total_msgs, win_users = excluded.win_users,
       linux_users = excluded.linux_users, mac_users = excluded.mac_users`
  ).bind(date, agg.dau, agg.eff_dau, agg.new_users, agg.total_msgs, agg.win_users, agg.linux_users, agg.mac_users).run();

  // Version distribution
  await env.DB.prepare(`DELETE FROM version_dist WHERE date = ?`).bind(date).run();
  await env.DB.prepare(
    `INSERT INTO version_dist (date, version, count)
     SELECT date, version, COUNT(*) FROM pings WHERE date = ? GROUP BY version`
  ).bind(date).run();
}

/**
 * Refresh summaries for the last N days (used by cron / manual trigger).
 */
export async function refreshDailySummary(env: Env): Promise<{ refreshed: number }> {
  const days: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  for (const day of days) {
    await refreshDay(env, day);
  }
  return { refreshed: days.length };
}

/**
 * 一次性重建:修正历史 first_seen(每设备仅最早那天为真),并以修正后的 pings 全量
 * 重建 daily_summary 与 version_dist。修首次部署后 first_seen 恒为 TRUE 的污染。
 */
export async function rebuildAll(env: Env): Promise<Record<string, number>> {
  await env.DB.prepare(
    `UPDATE pings SET first_seen = (date = (
       SELECT MIN(date) FROM pings p2 WHERE p2.device_id = pings.device_id
     ))`
  ).run();

  await env.DB.prepare(`DELETE FROM daily_summary`).run();
  await env.DB.prepare(
    `INSERT INTO daily_summary
       (date, dau, eff_dau, new_users, total_msgs, win_users, linux_users, mac_users)
     SELECT
       date,
       COUNT(*)                                          AS dau,
       SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END)    AS eff_dau,
       SUM(CASE WHEN first_seen THEN 1 ELSE 0 END)       AS new_users,
       SUM(msg_count)                                    AS total_msgs,
       SUM(CASE WHEN os = 'win'   THEN 1 ELSE 0 END)     AS win_users,
       SUM(CASE WHEN os = 'linux' THEN 1 ELSE 0 END)     AS linux_users,
       SUM(CASE WHEN os = 'mac'   THEN 1 ELSE 0 END)     AS mac_users
     FROM pings GROUP BY date`
  ).run();

  await env.DB.prepare(`DELETE FROM version_dist`).run();
  await env.DB.prepare(
    `INSERT INTO version_dist (date, version, count)
     SELECT date, version, COUNT(*) FROM pings GROUP BY date, version`
  ).run();

  const stats = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM pings)                       AS total_pings,
       (SELECT COUNT(DISTINCT device_id) FROM pings)      AS total_devices,
       (SELECT COUNT(*) FROM pings WHERE first_seen)      AS first_seen_rows,
       (SELECT COUNT(*) FROM daily_summary)               AS summary_days`
  ).first<any>();

  return stats ?? {};
}
