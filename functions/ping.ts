export const onRequest = async (context) => {
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  const date = url.searchParams.get("d");
  const version = url.searchParams.get("v") ?? "";
  const os = url.searchParams.get("os") ?? "";
  const mc = parseInt(url.searchParams.get("mc") ?? "0", 10);

  if (!id || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-f0-9-]{20,64}$/.test(id)) {
    return new Response(JSON.stringify({ ok: false, error: "bad params" }), {
      status: 400,
      headers: cors(),
    });
  }

  const clampedMc = Math.max(0, Math.min(mc, 999999));

  try {
    const DB = context.env.DB;

    // first_seen 只能对该设备"历史上第一次出现"为真。早期实现把 INSERT 的 first_seen
    // 恒为 TRUE、且 ON CONFLICT 不纠正它——由于主键是 (device_id, date),设备每跨入一个
    // 新日期都会再 INSERT 一行 first_seen=TRUE,于是每个活跃设备每天的行都是"首次出现",
    // SUM(first_seen) 退化成 DAU,"新增用户"恒等于日活,留存 cohort 也全错。
    // 这里先查该设备是否已有任意历史行(含今天之外),没有才是真正的新设备。
    // 极小竞态:同设备首次上报并发两次时两条都判定为新、一条 INSERT 另一条走 UPDATE,
    // UPDATE 不碰 first_seen,最终仍是 TRUE,数量不会翻倍。
    const prior = await DB.prepare(
      `SELECT 1 FROM pings WHERE device_id = ? LIMIT 1`
    ).bind(id).first();
    const isNew = !prior;

    await DB.prepare(
      `INSERT INTO pings (device_id, date, version, os, msg_count, first_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, date) DO UPDATE SET
         version   = excluded.version,
         os        = excluded.os,
         msg_count = MAX(msg_count, excluded.msg_count)`
    ).bind(id, date, version, os, clampedMc, isNew ? 1 : 0).run();

    await refreshDay(DB, date);

    return new Response(JSON.stringify({ ok: true }), { headers: cors() });
  } catch (err) {
    console.error("ping error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: cors() });
  }
};

function cors() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
}

async function refreshDay(DB, date) {
  const agg = await DB.prepare(
    `SELECT
       COUNT(*)                  AS dau,
       SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END) AS eff_dau,
       SUM(CASE WHEN first_seen THEN 1 ELSE 0 END)    AS new_users,
       SUM(msg_count)           AS total_msgs,
       SUM(CASE WHEN os = 'win' THEN 1 ELSE 0 END)    AS win_users,
       SUM(CASE WHEN os = 'linux' THEN 1 ELSE 0 END)  AS linux_users,
       SUM(CASE WHEN os = 'mac' THEN 1 ELSE 0 END)    AS mac_users
     FROM pings WHERE date = ?`
  ).bind(date).first();

  if (!agg || agg.dau === 0) return;

  await DB.prepare(
    `INSERT INTO daily_summary (date, dau, eff_dau, new_users, total_msgs, win_users, linux_users, mac_users)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       dau = excluded.dau, eff_dau = excluded.eff_dau, new_users = excluded.new_users,
       total_msgs = excluded.total_msgs, win_users = excluded.win_users,
       linux_users = excluded.linux_users, mac_users = excluded.mac_users`
  ).bind(date, agg.dau, agg.eff_dau, agg.new_users, agg.total_msgs, agg.win_users, agg.linux_users, agg.mac_users).run();

  await DB.prepare(`DELETE FROM version_dist WHERE date = ?`).bind(date).run();
  await DB.prepare(
    `INSERT INTO version_dist (date, version, count)
     SELECT date, version, COUNT(*) FROM pings WHERE date = ? GROUP BY version`
  ).bind(date).run();
}
