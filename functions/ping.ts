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
    await DB.prepare(
      `INSERT INTO pings (device_id, date, version, os, msg_count, first_seen)
       VALUES (?, ?, ?, ?, ?, TRUE)
       ON CONFLICT(device_id, date) DO UPDATE SET
         version   = excluded.version,
         os        = excluded.os,
         msg_count = MAX(msg_count, excluded.msg_count)`
    ).bind(id, date, version, os, clampedMc).run();

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
