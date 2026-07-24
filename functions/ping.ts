import { isValidDate, addDays } from "./_lib";

// 尽力而为的进程内频控:同一 isolate 内按 IP 限 30 次/10 分钟。isolate 会随时回收、
// 多 PoP 之间不共享,所以这只能挡住单点脚本刷量,不是完整方案——真正的兜底是
// Cloudflare 控制台给 /ping 配 WAF Rate Limiting 规则(正常客户端 10 分钟才 1 次)。
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX = 30;
const rlHits = new Map(); // ip -> number[](时间戳)

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const arr = (rlHits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) { rlHits.set(ip, arr); return true; }
  arr.push(now);
  rlHits.set(ip, arr);
  if (rlHits.size > 10000) rlHits.clear(); // 防 Map 无界膨胀,清了重来
  return false;
}

export const onRequest = async (context) => {
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  const date = url.searchParams.get("d");
  // version / os 会被看板直接拼进 innerHTML 渲染,必须在入库前白名单收口,堵存储型
  // XSS(本端点公开,任何人都能构造带恶意 version 的 ping)。非法值降级为空串而非拒收
  // ——避免误杀合法客户端;空值在看板显示为 "(unknown)"、系统分布归入 other。
  const rawVer = url.searchParams.get("v") ?? "";
  const version = /^[\w.\-+ ]{0,32}$/.test(rawVer) ? rawVer : "";
  const rawOs = (url.searchParams.get("os") ?? "").toLowerCase();
  const os = (rawOs === "win" || rawOs === "mac" || rawOs === "linux") ? rawOs : "";
  const mc = parseInt(url.searchParams.get("mc") ?? "0", 10);
  // 扩展遥测(纯计数,无内容):hb=当日心跳数(≈时长/10min)、er=provider 失败数、
  // fs/ft/fm/fi=搜索/TTS/MCP/图像生成次数。旧客户端不带这些参数,一律落 0。
  const clampCount = (key) => {
    const n = parseInt(url.searchParams.get(key) ?? "0", 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(n, 999999)) : 0;
  };
  const hb = clampCount("hb"), er = clampCount("er");
  const fs = clampCount("fs"), ft = clampCount("ft"), fm = clampCount("fm"), fi = clampCount("fi");
  // 国家码来自 CF 边缘(request.cf),不采集/不存 IP;仅 ISO 两位码白名单。
  const rawCountry = String(context.request.cf?.country ?? "");
  const country = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : "";

  if (!id || !date || !isValidDate(date) || !/^[a-f0-9-]{20,64}$/.test(id)) {
    return new Response(JSON.stringify({ ok: false, error: "bad params" }), {
      status: 400,
      headers: cors(),
    });
  }

  // 客户端上报的是"本地日期",时区跨 UTC-12..+14,与服务器 UTC 最多差一天;超出
  // ±1 天窗口的必然是时钟错乱或伪造(伪造历史日期可直接篡改 cohort/留存矩阵),拒收。
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (date < addDays(todayUtc, -1) || date > addDays(todayUtc, 1)) {
    return new Response(JSON.stringify({ ok: false, error: "date out of range" }), {
      status: 400,
      headers: cors(),
    });
  }

  if (rateLimited(context.request.headers.get("cf-connecting-ip"))) {
    return new Response(JSON.stringify({ ok: false, error: "rate limited" }), {
      status: 429,
      headers: cors(),
    });
  }

  // 公开端点,mc 可能是非数字垃圾值;parseInt 遇之得 NaN,Math.min/max 会一路
  // 把 NaN 透传到 D1 bind(SQLite 不存 NaN,行为未定义)。先 isFinite 兜底成 0。
  const clampedMc = Number.isFinite(mc) ? Math.max(0, Math.min(mc, 999999)) : 0;

  try {
    const DB = context.env.DB;

    // 一次读取拿到:该设备是否有任何历史行(first_seen 判定)+ 今天这行的当前值
    // (判断本次 ping 带来哪一级变化)。旧实现每次心跳都无条件 UPSERT + 全天重聚合 +
    // 重建 version_dist(6 条写查询),是 D1 写放大的最大来源。现在分三级:
    //   完全无变化      → 只花这 1 次读;
    //   仅计数器变化    → +1 次 UPSERT(hb 每 10 分钟必然 +1,这是会话时长信号的底价);
    //   影响汇总的变化  → 再加 daily_summary 刷新;版本变化才重建 version_dist。
    // LEFT JOIN 常量行保证恒返回一行,今天无记录时 p.* 全为 NULL。
    //
    // first_seen 只能对该设备"历史上第一次出现"为真。极小竞态:同设备首次上报并发
    // 两次时两条都判定为新、一条 INSERT 另一条走 UPDATE,UPDATE 不碰 first_seen,
    // 最终仍是 TRUE,数量不会翻倍。
    const pre = await DB.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM pings WHERE device_id = ?1) AS has_any,
         p.msg_count AS cur_mc, p.version AS cur_ver, p.os AS cur_os, p.country AS cur_country,
         p.hb_count AS cur_hb, p.err_count AS cur_er,
         p.feat_search AS cur_fs, p.feat_tts AS cur_ft, p.feat_mcp AS cur_fm, p.feat_img AS cur_fi
       FROM (SELECT 1) LEFT JOIN pings p ON p.device_id = ?1 AND p.date = ?2`
    ).bind(id, date).first();

    const isNew = !pre?.has_any;
    const hasToday = pre?.cur_mc != null;
    const countersUp = !hasToday
      || clampedMc > pre.cur_mc || hb > pre.cur_hb || er > pre.cur_er
      || fs > pre.cur_fs || ft > pre.cur_ft || fm > pre.cur_fm || fi > pre.cur_fi;
    const identityChanged = hasToday && (version !== pre.cur_ver || os !== pre.cur_os || (country !== "" && country !== pre.cur_country));

    if (countersUp || identityChanged) {
      await DB.prepare(
        `INSERT INTO pings (device_id, date, version, os, country, msg_count, hb_count, err_count,
                            feat_search, feat_tts, feat_mcp, feat_img, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, date) DO UPDATE SET
           version     = excluded.version,
           os          = excluded.os,
           country     = CASE WHEN excluded.country != '' THEN excluded.country ELSE country END,
           msg_count   = MAX(msg_count, excluded.msg_count),
           hb_count    = MAX(hb_count, excluded.hb_count),
           err_count   = MAX(err_count, excluded.err_count),
           feat_search = MAX(feat_search, excluded.feat_search),
           feat_tts    = MAX(feat_tts, excluded.feat_tts),
           feat_mcp    = MAX(feat_mcp, excluded.feat_mcp),
           feat_img    = MAX(feat_img, excluded.feat_img)`
      ).bind(id, date, version, os, country, clampedMc, hb, er, fs, ft, fm, fi, isNew ? 1 : 0).run();

      // daily_summary 只含 dau/eff_dau/new_users/total_msgs/os 计数——心跳、失败数、
      // 功能计数的变化不影响它;version_dist 只在新行或版本变化时重建。
      const refreshSummary = !hasToday || clampedMc > (pre?.cur_mc ?? -1) || (hasToday && os !== pre.cur_os);
      const refreshVersions = !hasToday || (hasToday && version !== pre.cur_ver);
      if (refreshSummary || refreshVersions) {
        context.waitUntil(refreshDay(DB, date, refreshVersions).catch((err) => {
          console.error("refreshDay error:", err);
        }));
      }
    }

    return new Response(JSON.stringify({ ok: true }), { headers: cors() });
  } catch (err) {
    console.error("ping error:", err);
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: cors() });
  }
};

function cors() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
}

async function refreshDay(DB, date, refreshVersions) {
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

  if (!refreshVersions) return;
  await DB.prepare(`DELETE FROM version_dist WHERE date = ?`).bind(date).run();
  await DB.prepare(
    `INSERT INTO version_dist (date, version, count)
     SELECT date, version, COUNT(*) FROM pings WHERE date = ? GROUP BY version`
  ).bind(date).run();
}
