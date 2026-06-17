// 一次性维护端点:修正历史 first_seen,并用修正后的 pings 全量重建 daily_summary 与
// version_dist。用于修复首次部署后"first_seen 恒为 TRUE"造成的数据污染——光改 ping.ts
// 只能让新数据正确,历史 daily_summary 仍停在错误值上,必须重建一次。
//
// 调用:POST /api/admin/rebuild?token=<AUTH_TOKEN>
// 建议在每次部署 ping.ts 修复后执行一次,之后只在怀疑数据再次不一致时手动跑。
export const onRequest = async (context) => {
  const url = new URL(context.request.url);
  if (!context.env.AUTH_TOKEN || url.searchParams.get("token") !== context.env.AUTH_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const DB = context.env.DB;
  const t0 = Date.now();
  try {
    // 1) 对每个设备,只有它最早出现那一天 first_seen 为真,其余全部置假。
    //    关联子查询 O(n),数据量不大可接受;一次性维护,不必常驻。
    await DB.prepare(
      `UPDATE pings SET first_seen = (date = (
         SELECT MIN(date) FROM pings p2 WHERE p2.device_id = pings.device_id
       ))`
    ).run();

    // 2) 用修正后的 first_seen 全量重建 daily_summary(含 new_users / 各 OS 计数)。
    await DB.prepare(`DELETE FROM daily_summary`).run();
    await DB.prepare(
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

    // 3) 重建 version_dist。
    await DB.prepare(`DELETE FROM version_dist`).run();
    await DB.prepare(
      `INSERT INTO version_dist (date, version, count)
       SELECT date, version, COUNT(*) FROM pings GROUP BY date, version`
    ).run();

    const stats = await DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM pings)                       AS total_pings,
         (SELECT COUNT(DISTINCT device_id) FROM pings)      AS total_devices,
         (SELECT COUNT(*) FROM pings WHERE first_seen)      AS first_seen_rows,
         (SELECT COUNT(*) FROM daily_summary)               AS summary_days`
    ).first();

    return new Response(JSON.stringify({
      ok: true,
      ms: Date.now() - t0,
      ...stats,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("rebuild error:", err);
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
