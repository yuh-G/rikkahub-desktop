import type { Env } from "./index";

/**
 * GET /api/stats?token=...&days=30
 *
 * Returns all dashboard data in one payload.
 */
export async function getStats(url: URL, env: Env): Promise<Record<string, any>> {
  const days = Math.min(parseInt(url.searchParams.get("days") ?? "30", 10), 180);

  // ── Daily trends ─────────────────────────────────────────────────
  const trends = await env.DB.prepare(
    `SELECT date, dau, eff_dau, new_users, total_msgs, win_users, linux_users
     FROM daily_summary
     ORDER BY date DESC LIMIT ?`
  ).bind(days).all<any>();

  // ── WAU / MAU ────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const wau = await uniqueDevices(env, today, 7);
  const mau = await uniqueDevices(env, today, 30);

  // ── Stickiness ───────────────────────────────────────────────────
  const todayRow = trends.rows?.[0];
  const dau = todayRow?.dau ?? 0;
  const stickiness = mau > 0 ? Math.round((dau / mau) * 100) : 0;

  // ── Avg messages per active user ─────────────────────────────────
  const avgMsgs = await env.DB.prepare(
    `SELECT AVG(msg_count) AS avg FROM pings WHERE date = ? AND msg_count > 0`
  ).bind(today).first<any>();

  // ── Version distribution (latest day) ────────────────────────────
  const versions = await env.DB.prepare(
    `SELECT version, count FROM version_dist
     WHERE date = (SELECT MAX(date) FROM version_dist)
     ORDER BY count DESC`
  ).all<any>();

  // ── Retention cohort ─────────────────────────────────────────────
  const retention = await computeRetention(env, 30);

  return {
    trends: (trends.rows ?? []).reverse(), // oldest first for charting
    wau,
    mau,
    stickiness,
    avgMsgsPerActive: Math.round((avgMsgs?.avg ?? 0) * 10) / 10,
    versions: versions.rows ?? [],
    retention,
  };
}

async function uniqueDevices(env: Env, endDate: string, windowDays: number): Promise<number> {
  const start = new Date(endDate);
  start.setDate(start.getDate() - windowDays + 1);
  const startDate = start.toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT device_id) AS cnt FROM pings WHERE date BETWEEN ? AND ?`
  ).bind(startDate, endDate).first<any>();
  return row?.cnt ?? 0;
}

/**
 * Compute a simplified retention table: for each cohort (signup date),
 * what % came back on day 1, 3, 7, 14, 30.
 */
async function computeRetention(
  env: Env,
  cohortDays: number
): Promise<{ cohorts: any[] }> {
  // Get recent cohorts (first_seen dates)
  const cohorts = await env.DB.prepare(
    `SELECT date, COUNT(*) AS size
     FROM pings
     WHERE first_seen = TRUE AND date >= date('now', ?)
     GROUP BY date
     ORDER BY date DESC
     LIMIT 30`
  ).bind(`-${cohortDays} days`).all<any>();

  if (!cohorts.rows?.length) return { cohorts: [] };

  const result = [];
  const offsets = [1, 3, 7, 14, 30];

  for (const cohort of cohorts.rows) {
    const cohortDate = cohort.date;
    const cohortSize = cohort.size;
    const retention: Record<number, number> = {};

    for (const offset of offsets) {
      const targetDate = new Date(cohortDate + "T00:00:00Z");
      targetDate.setUTCDate(targetDate.getUTCDate() + offset);
      const target = targetDate.toISOString().slice(0, 10);

      // Don't query future dates
      if (target > new Date().toISOString().slice(0, 10)) continue;

      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM pings
         WHERE device_id IN (SELECT device_id FROM pings WHERE date = ? AND first_seen = TRUE)
         AND date = ?`
      ).bind(cohortDate, target).first<any>();

      retention[offset] = cohortSize > 0 ? Math.round(((row?.cnt ?? 0) / cohortSize) * 100) : 0;
    }

    result.push({ date: cohortDate, size: cohortSize, retention });
  }

  return { cohorts: result };
}
