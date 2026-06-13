export const onRequest = async (context) => {
  const url = new URL(context.request.url);
  const DB = context.env.DB;
  const days = Math.min(parseInt(url.searchParams.get("days") ?? "30", 10), 180);

  try {
    const trends = await DB.prepare(
      `SELECT date, dau, eff_dau, new_users, total_msgs, win_users, linux_users, mac_users
       FROM daily_summary ORDER BY date DESC LIMIT ?`
    ).bind(days).all();

    const today = new Date().toISOString().slice(0, 10);
    const wau = await uniqueDevices(DB, today, 7);
    const mau = await uniqueDevices(DB, today, 30);

    const todayRow = trends.results?.[0];
    const dau = todayRow?.dau ?? 0;
    const stickinessMau = mau > 0 ? Math.round((dau / mau) * 100) : 0;
    const stickinessWau = wau > 0 ? Math.round((dau / wau) * 100) : 0;

    // ── 累计用户(历史所有) ──
    const totalRow = await DB.prepare(
      `SELECT COUNT(DISTINCT device_id) AS cnt FROM pings`
    ).first();
    const totalUsers = totalRow?.cnt ?? 0;

    // ── 历史峰值 DAU ──
    const peakRow = await DB.prepare(
      `SELECT MAX(dau) AS peak, date FROM daily_summary`
    ).first();
    const peakDau = peakRow?.peak ?? 0;
    const peakDate = peakRow?.date ?? null;

    // ── 当日平均消息数 ──
    const avgMsgs = await DB.prepare(
      `SELECT AVG(msg_count) AS avg FROM pings WHERE date = ? AND msg_count > 0`
    ).bind(today).first();

    // ── 会话深度分布(过去 7 天) ──
    const sevenDaysAgo = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return d.toISOString().slice(0, 10);
    })();
    const buckets = await DB.prepare(
      `SELECT
         SUM(CASE WHEN msg_count = 0 THEN 1 ELSE 0 END)                              AS b0,
         SUM(CASE WHEN msg_count BETWEEN 1 AND 5 THEN 1 ELSE 0 END)                  AS b1_5,
         SUM(CASE WHEN msg_count BETWEEN 6 AND 20 THEN 1 ELSE 0 END)                 AS b6_20,
         SUM(CASE WHEN msg_count > 20 THEN 1 ELSE 0 END)                             AS b20p
       FROM pings WHERE date >= ?`
    ).bind(sevenDaysAgo).first();

    const versions = await DB.prepare(
      `SELECT version, count FROM version_dist
       WHERE date = (SELECT MAX(date) FROM version_dist)
       ORDER BY count DESC`
    ).all();

    const retention = await computeRetention(DB, 60);

    // ── 平均留存率(D1/D7/D30) ──
    const avgRetention = computeAvgRetention(retention.cohorts);

    return new Response(JSON.stringify({
      trends: (trends.results ?? []).reverse(),
      wau, mau,
      stickiness: stickinessMau,         // 兼容老字段
      stickinessMau, stickinessWau,
      totalUsers,
      peakDau, peakDate,
      avgMsgsPerActive: Math.round((avgMsgs?.avg ?? 0) * 10) / 10,
      depth: {
        b0: buckets?.b0 ?? 0,
        b1_5: buckets?.b1_5 ?? 0,
        b6_20: buckets?.b6_20 ?? 0,
        b20p: buckets?.b20p ?? 0,
      },
      avgRetention,
      versions: versions.results ?? [],
      retention,
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    console.error("stats error:", err);
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
};

async function uniqueDevices(DB, endDate, windowDays) {
  const start = new Date(endDate);
  start.setDate(start.getDate() - windowDays + 1);
  const startDate = start.toISOString().slice(0, 10);
  const row = await DB.prepare(
    `SELECT COUNT(DISTINCT device_id) AS cnt FROM pings WHERE date BETWEEN ? AND ?`
  ).bind(startDate, endDate).first();
  return row?.cnt ?? 0;
}

async function computeRetention(DB, cohortDays) {
  try {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - cohortDays);
    const since = sinceDate.toISOString().slice(0, 10);

    const cohorts = await DB.prepare(
      `SELECT date, COUNT(*) AS size FROM pings
       WHERE first_seen = TRUE AND date >= ?
       GROUP BY date ORDER BY date DESC LIMIT 60`
    ).bind(since).all();

    if (!cohorts.results?.length) return { cohorts: [] };

    const result = [];
    const offsets = [1, 3, 7, 14, 30];

    for (const cohort of cohorts.results) {
      const retention = {};
      for (const offset of offsets) {
        const targetDate = new Date(cohort.date + "T00:00:00Z");
        targetDate.setUTCDate(targetDate.getUTCDate() + offset);
        const target = targetDate.toISOString().slice(0, 10);
        if (target > new Date().toISOString().slice(0, 10)) continue;

        const row = await DB.prepare(
          `SELECT COUNT(*) AS cnt FROM pings
           WHERE device_id IN (SELECT device_id FROM pings WHERE date = ? AND first_seen = TRUE)
           AND date = ?`
        ).bind(cohort.date, target).first();

        retention[offset] = cohort.size > 0 ? Math.round(((row?.cnt ?? 0) / cohort.size) * 100) : 0;
      }
      result.push({ date: cohort.date, size: cohort.size, retention });
    }
    return { cohorts: result };
  } catch (err) {
    console.error("retention error:", err);
    return { cohorts: [] };
  }
}

// 聚合所有 cohort 的 D1/D7/D30 平均留存。只看 cohort 满龄(有足够天数能算)的样本,
// 避免今天新增用户的 D7 一定是 0% 拉低均值。
function computeAvgRetention(cohorts) {
  const result = { d1: null, d7: null, d30: null };
  if (!cohorts?.length) return result;

  for (const [key, offset] of [['d1', 1], ['d7', 7], ['d30', 30]]) {
    const valid = cohorts.filter(c => c.retention[offset] != null);
    if (!valid.length) continue;
    // 加权平均:大 cohort 比小 cohort 影响更大
    const totalUsers = valid.reduce((s, c) => s + c.size, 0);
    const weighted = valid.reduce((s, c) => s + c.retention[offset] * c.size, 0);
    result[key] = totalUsers > 0 ? Math.round(weighted / totalUsers) : null;
  }
  return result;
}
