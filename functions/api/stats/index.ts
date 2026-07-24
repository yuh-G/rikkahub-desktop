// GET /api/stats?days=30&os=all&version=all&segment=all&start=&end=
// 鉴权:HttpOnly cookie(dashboard 下发)或 ?token=(curl 场景)。
//
// 设计要点(历史缺陷已修,见 git log):
//   - 无筛选时读 daily_summary / version_dist 缓存表,筛选时回退 pings 实时聚合;
//   - 留存/滚动留存用 CTE 一次展开,替代 N+1;
//   - 所有独立查询 Promise.all 并行;
//   - trends 按日期区间补零:没有 ping 的日子(服务中断/零活跃)也要画成 0,
//     否则趋势图直接跳过该天,视觉上"看不出出过事"。
import { isAuthorized, isValidDate, addDays } from "../../_lib";

export const onRequest = async (context) => {
  const url = new URL(context.request.url);

  if (!isAuthorized(context, url)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const DB = context.env.DB;
  const daysRaw = url.searchParams.get("days") ?? "30";
  // days 可能是非法值(?days=foo → NaN,?days=-5 → 未来起始日、整页空白),
  // 统一钳制到 [1, 365],"all" 走全历史。
  const parsedDays = parseInt(daysRaw, 10);
  const daysParam = daysRaw === "all" ? 99999
    : (Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 365) : 30);
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const osFilter = (url.searchParams.get("os") ?? "all").toLowerCase();
  const verFilter = url.searchParams.get("version") ?? "all";
  const segment = (url.searchParams.get("segment") ?? "all").toLowerCase();

  // 公共筛选:os/version 按 ping 行;segment 按 device 首现日 cohort。
  const filters = [];
  if (osFilter !== "all") filters.push({ sql: "os = ?", val: osFilter });
  if (verFilter !== "all") filters.push({ sql: "version = ?", val: verFilter });
  const filterSql = filters.map((f) => f.sql).join(" AND ");
  const filterBinds = filters.map((f) => f.val);
  const filterAnd = filterSql ? " AND " + filterSql : "";
  const filterWhere = filterSql ? " WHERE " + filterSql : "";

  try {
    // 数据最新日(用数据本身而非服务器 UTC,消除时区偏移)。
    const latestRow = await DB.prepare("SELECT MAX(date) AS d FROM pings" + filterWhere).bind(...filterBinds).first();
    const today = endParam && isValidDate(endParam) ? endParam : (latestRow?.d ?? new Date().toISOString().slice(0, 10));
    const days = startParam && isValidDate(startParam)
      ? Math.max(1, Math.round((new Date(today) - new Date(startParam)) / 86400000) + 1)
      : daysParam;

    let startDate;
    if (startParam && isValidDate(startParam)) {
      startDate = startParam;
    } else if (daysRaw === "all") {
      const minRow = await DB.prepare("SELECT MIN(date) AS d FROM pings" + filterWhere).bind(...filterBinds).first();
      startDate = minRow?.d ?? today;
    } else {
      startDate = addDays(today, -(days - 1));
    }
    if (startDate > today) startDate = today;

    // segment cohort 片段
    let cohortAnd = "";
    let cohortBinds = [];
    if (segment === "new") {
      cohortAnd = " AND device_id IN (SELECT device_id FROM pings WHERE first_seen = 1 AND date BETWEEN ? AND ?)";
      cohortBinds = [startDate, today];
    } else if (segment === "returning") {
      cohortAnd = " AND device_id IN (SELECT device_id FROM pings WHERE first_seen = 1 AND date < ?)";
      cohortBinds = [startDate];
    }
    const allBinds = [...filterBinds, ...cohortBinds];
    const allAnd = filterAnd + cohortAnd;

    // 无任何筛选时才能安全读缓存表(它们不存 segment/os/version 细分)。
    const noFilter = osFilter === "all" && verFilter === "all" && segment === "all";

    // 派生日期先算好,供下方并行查询复用。
    const sevenDaysAgo = addDays(today, -6);
    const vtStart = addDays(today, -29);
    const pctStart = startDate < addDays(today, -89) ? addDays(today, -89) : startDate;
    const pctEnd = addDays(today, -1);
    const stStart = startDate < addDays(today, -89) ? addDays(today, -89) : startDate; // 粘性趋势上限 90 天
    const powerStart = addDays(today, -29); // Power Curve 固定近 30 天窗口

    // 下面这些查询彼此独立(都只依赖 startDate/today/allAnd/allBinds 等已就绪的变量),
    // 用 Promise.all 并行发起,把串行往返(每次 20-50ms RTT)压到一两跳。
    // 期间对比:上一个等长窗口(全部历史时无意义,跳过)。
    const rangeLen = Math.max(1, Math.round((new Date(today) - new Date(startDate)) / 86400000) + 1);
    const prevEnd = addDays(startDate, -1);
    const prevStart = addDays(startDate, -rangeLen);
    const wantPrev = daysRaw !== "all" && rangeLen <= 365;

    const [
      trendsRaw, wau, mau, totalRow, buckets, verOsRaw,
      versionTrend, growth, retention, rollingRetention, churn, percentiles, recentUsers,
      growthAccounting, powerCurveRaw, stickinessRaw, cohortQuality,
      prevTrendsRaw, featureUseRow, qualityRaw
    ] = await Promise.all([
      // 日趋势:无筛选读 daily_summary 缓存(快),有筛选从 pings 实时聚合。
      noFilter
        ? DB.prepare(
            "SELECT date, dau, eff_dau, new_users, (dau - new_users) AS returning_users, " +
            "total_msgs, win_users, linux_users, mac_users " +
            "FROM daily_summary WHERE date BETWEEN ? AND ? ORDER BY date"
          ).bind(startDate, today).all()
        : DB.prepare(
            "SELECT date, " +
            "COUNT(*) AS dau, " +
            "SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END) AS eff_dau, " +
            "SUM(CASE WHEN first_seen THEN 1 ELSE 0 END) AS new_users, " +
            "SUM(CASE WHEN first_seen = 0 THEN 1 ELSE 0 END) AS returning_users, " +
            "SUM(msg_count) AS total_msgs, " +
            "SUM(CASE WHEN os = 'win' THEN 1 ELSE 0 END) AS win_users, " +
            "SUM(CASE WHEN os = 'linux' THEN 1 ELSE 0 END) AS linux_users, " +
            "SUM(CASE WHEN os = 'mac' THEN 1 ELSE 0 END) AS mac_users " +
            "FROM pings WHERE date BETWEEN ? AND ? " + allAnd + " GROUP BY date ORDER BY date"
          ).bind(startDate, today, ...allBinds).all(),
      // WAU / MAU(跨天 distinct,无法用日聚合缓存,始终走 pings)。
      uniqueDevices(DB, today, 7, allAnd, allBinds),
      uniqueDevices(DB, today, 30, allAnd, allBinds),
      // 累计用户。
      DB.prepare("SELECT COUNT(DISTINCT device_id) AS cnt FROM pings WHERE 1=1 " + allAnd).bind(...allBinds).first(),
      // 会话深度(近 7 天分桶;单位是"设备-日"记录,非去重设备)。
      DB.prepare(
        "SELECT " +
        "SUM(CASE WHEN msg_count = 0 THEN 1 ELSE 0 END) AS b0, " +
        "SUM(CASE WHEN msg_count BETWEEN 1 AND 5 THEN 1 ELSE 0 END) AS b1_5, " +
        "SUM(CASE WHEN msg_count BETWEEN 6 AND 20 THEN 1 ELSE 0 END) AS b6_20, " +
        "SUM(CASE WHEN msg_count > 20 THEN 1 ELSE 0 END) AS b20p " +
        "FROM pings WHERE date >= ? " + allAnd
      ).bind(sevenDaysAgo, ...allBinds).first(),
      // 版本 × 系统 × 国家分布(一条查询同时供 versions/osDist/countryDist 使用):
      // 全量用户"最新一次上报"的快照。刻意不叠筛选——这是稳定全集。
      DB.prepare(
        "SELECT version, os, country, COUNT(*) AS c FROM (" +
        "  SELECT device_id, version, os, country, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY date DESC, created_at DESC) AS rn FROM pings" +
        ") WHERE rn = 1 GROUP BY version, os, country"
      ).all(),
      // 版本采用曲线(近 30 天):读 version_dist 缓存(由 refreshDay 维护)。
      DB.prepare(
        "SELECT date, version, count AS c FROM version_dist WHERE date BETWEEN ? AND ? ORDER BY date"
      ).bind(vtStart, today).all(),
      // 累计增长曲线。注意:allAnd 含 segment cohort 的占位符时,bind 也必须含
      // cohortBinds(allBinds),否则 ? 数与 bind 数不匹配会让整条 stats 500。
      computeGrowth(DB, allAnd, allBinds),
      // 新用户 cohort 留存 + 全量滚动留存:留存是 cohort 分析,按 os/版本切片样本太小、
      // 波动大,统一用全量口径(内部已用 CTE 批量)。
      computeRetention(DB, today, 60),
      computeRollingRetention(DB, today, 60),
      // 流失 / 复活:窗口排除"未结束的今天",近 7 天 = [asOf-7, asOf-1]。
      computeChurn(DB, today, filterAnd, filterBinds),
      // 参与度分位:窗口上限 90 天、排除今天(今天消息还在累积,分位不准)。
      computePercentiles(DB, pctStart, pctEnd, allAnd, allBinds),
      // 最近活跃设备(版本/os 取该设备最新一条)。
      DB.prepare(
        "SELECT device_id, " +
        "MIN(date) AS first_date, MAX(date) AS last_date, " +
        "SUM(msg_count) AS total_msgs, COUNT(*) AS active_days, " +
        "(SELECT version FROM pings p2 WHERE p2.device_id = p.device_id ORDER BY date DESC LIMIT 1) AS version, " +
        "(SELECT os FROM pings p2 WHERE p2.device_id = p.device_id ORDER BY date DESC LIMIT 1) AS os " +
        "FROM pings p WHERE 1=1 " + allAnd + " GROUP BY device_id ORDER BY last_date DESC, total_msgs DESC LIMIT 500"
      ).bind(...allBinds).all(),
      // 增长会计(周):新增 + 复活 + 留存 − 流失,运营判断增长是否健康的第一张图。
      computeGrowthAccounting(DB, startDate, today, filterAnd, filterWhere, filterBinds),
      // Power User Curve:近 30 天每设备活跃天数直方图。
      DB.prepare(
        "SELECT ad AS days, COUNT(*) AS devices FROM (" +
        "  SELECT device_id, COUNT(*) AS ad FROM pings WHERE date BETWEEN ? AND ? " + allAnd + " GROUP BY device_id" +
        ") GROUP BY ad ORDER BY ad"
      ).bind(powerStart, today, ...allBinds).all(),
      // 粘性趋势:逐日 DAU/WAU/MAU(相关子查询,窗口 ≤90 天,当前数据量可承受)。
      DB.prepare(
        "WITH days AS (SELECT DISTINCT date AS d FROM pings WHERE date BETWEEN ? AND ?) " +
        "SELECT d AS date, " +
        "(SELECT COUNT(DISTINCT device_id) FROM pings WHERE date = days.d " + allAnd + ") AS dau, " +
        "(SELECT COUNT(DISTINCT device_id) FROM pings WHERE date BETWEEN date(days.d,'-6 days') AND days.d " + allAnd + ") AS wau, " +
        "(SELECT COUNT(DISTINCT device_id) FROM pings WHERE date BETWEEN date(days.d,'-29 days') AND days.d " + allAnd + ") AS mau " +
        "FROM days ORDER BY d"
      ).bind(stStart, today, ...allBinds, ...allBinds, ...allBinds).all(),
      // 新用户首周参与质量:每周新增 cohort 在首 7 天的人均消息(全量口径,同留存)。
      computeCohortQuality(DB, today),
      // 上一个等长窗口的日趋势(期间对比叠加用),口径与 trends 完全一致。
      wantPrev
        ? (noFilter
            ? DB.prepare(
                "SELECT date, dau, eff_dau, new_users, (dau - new_users) AS returning_users, " +
                "total_msgs, win_users, linux_users, mac_users " +
                "FROM daily_summary WHERE date BETWEEN ? AND ? ORDER BY date"
              ).bind(prevStart, prevEnd).all()
            : DB.prepare(
                "SELECT date, COUNT(*) AS dau, " +
                "SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END) AS eff_dau, " +
                "SUM(CASE WHEN first_seen THEN 1 ELSE 0 END) AS new_users, " +
                "SUM(CASE WHEN first_seen = 0 THEN 1 ELSE 0 END) AS returning_users, " +
                "SUM(msg_count) AS total_msgs, " +
                "SUM(CASE WHEN os = 'win' THEN 1 ELSE 0 END) AS win_users, " +
                "SUM(CASE WHEN os = 'linux' THEN 1 ELSE 0 END) AS linux_users, " +
                "SUM(CASE WHEN os = 'mac' THEN 1 ELSE 0 END) AS mac_users " +
                "FROM pings WHERE date BETWEEN ? AND ? " + allAnd + " GROUP BY date ORDER BY date"
              ).bind(prevStart, prevEnd, ...allBinds).all())
        : Promise.resolve({ results: [] }),
      // 功能使用度(近 7 天):各功能"当日用过 ≥1 次"的去重设备数。旧客户端不上报
      // 功能计数,列全为 0,前端据 base 与总和判断是否显示等待提示。
      DB.prepare(
        "SELECT " +
        "COUNT(DISTINCT CASE WHEN msg_count > 0 THEN device_id END) AS chat, " +
        "COUNT(DISTINCT CASE WHEN feat_search > 0 THEN device_id END) AS search, " +
        "COUNT(DISTINCT CASE WHEN feat_tts > 0 THEN device_id END) AS tts, " +
        "COUNT(DISTINCT CASE WHEN feat_mcp > 0 THEN device_id END) AS mcp, " +
        "COUNT(DISTINCT CASE WHEN feat_img > 0 THEN device_id END) AS img, " +
        "COUNT(DISTINCT device_id) AS base " +
        "FROM pings WHERE date BETWEEN ? AND ? " + allAnd
      ).bind(sevenDaysAgo, today, ...allBinds).first(),
      // 质量趋势:逐日失败数 / 消息数 / 平均使用时长(hb×10 分钟,仅统计有心跳上报的设备)。
      DB.prepare(
        "SELECT date, SUM(err_count) AS errs, SUM(msg_count) AS msgs, " +
        "ROUND(AVG(CASE WHEN hb_count > 0 THEN hb_count * 10.0 END), 0) AS avg_minutes " +
        "FROM pings WHERE date BETWEEN ? AND ? " + allAnd + " GROUP BY date ORDER BY date"
      ).bind(startDate, today, ...allBinds).all(),
    ]);

    // 补零:daily_summary / GROUP BY date 都只有有 ping 的日子才有行。
    const trends = zeroFillTrends(trendsRaw.results ?? [], startDate, today);
    const todayRow = trends[trends.length - 1] ?? {};
    const dau = todayRow?.dau ?? 0;
    const stickinessMau = mau > 0 ? Math.round((dau / mau) * 100) : 0;
    const stickinessWau = wau > 0 ? Math.round((dau / wau) * 100) : 0;
    const totalUsers = totalRow?.cnt ?? 0;
    // avgRetention 依赖 retention 结果,须在并行结束后算。
    const avgRetention = computeAvgRetention(retention.cohorts);

    // versions / osDist / countryDist 从同一份"每设备最新上报"快照派生。
    const verMap = new Map();
    const countryMap = new Map();
    const osDist = { win: 0, mac: 0, linux: 0, other: 0 };
    for (const r of verOsRaw.results ?? []) {
      verMap.set(r.version, (verMap.get(r.version) ?? 0) + r.c);
      if (r.os === "win" || r.os === "mac" || r.os === "linux") osDist[r.os] += r.c;
      else osDist.other += r.c;
      const cc = r.country || "";
      countryMap.set(cc, (countryMap.get(cc) ?? 0) + r.c);
    }
    const versions = [...verMap.entries()]
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.count - a.count);
    const countryDist = [...countryMap.entries()]
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count);

    const stickinessTrend = (stickinessRaw.results ?? []).map((r) => ({
      dau: r.dau,
      mau: r.mau,
      date: r.date,
      dauWau: r.wau > 0 ? Math.round((r.dau / r.wau) * 100) : 0,
      dauMau: r.mau > 0 ? Math.round((r.dau / r.mau) * 100) : 0,
    }));

    return new Response(JSON.stringify({
      trends,
      wau, mau,
      stickiness: stickinessMau,
      stickinessMau, stickinessWau,
      totalUsers,
      depth: { b0: buckets?.b0 ?? 0, b1_5: buckets?.b1_5 ?? 0, b6_20: buckets?.b6_20 ?? 0, b20p: buckets?.b20p ?? 0 },
      versions,
      osDist,
      avgRetention,
      retention,
      rollingRetention,
      growth,
      recentUsers: recentUsers.results ?? [],
      churn,
      percentiles,
      versionTrend: versionTrend.results ?? [],
      growthAccounting,
      powerCurve: powerCurveRaw.results ?? [],
      stickinessTrend,
      cohortQuality,
      prevTrends: wantPrev ? zeroFillTrends(prevTrendsRaw.results ?? [], prevStart, prevEnd) : [],
      featureUse: featureUseRow ?? null,
      qualityTrend: qualityRaw.results ?? [],
      countryDist,
      filter: { os: osFilter, version: verFilter, segment, range: daysRaw, startDate, asOf: today },
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("stats error:", err);
    // 不把后端错误细节透出到页面。
    return new Response(JSON.stringify({ error: "stats failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

// 把趋势行按 [start, end] 逐日补零(缺行 = 当日零活跃)。上限 1000 天防失控。
function zeroFillTrends(rows, start, end) {
  const by = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  let d = start;
  for (let i = 0; i < 1000 && d <= end; i++) {
    out.push(by.get(d) ?? {
      date: d, dau: 0, eff_dau: 0, new_users: 0, returning_users: 0,
      total_msgs: 0, win_users: 0, linux_users: 0, mac_users: 0,
    });
    d = addDays(d, 1);
  }
  return out;
}

// ISO 周一。SQLite 侧同款写法是 date(x, '-6 days', 'weekday 1')。
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function uniqueDevices(DB, endDate, windowDays, filterAnd, filterBinds) {
  const startDate = addDays(endDate, -(windowDays - 1));
  const row = await DB.prepare(
    "SELECT COUNT(DISTINCT device_id) AS cnt FROM pings WHERE date BETWEEN ? AND ? " + filterAnd
  ).bind(startDate, endDate, ...filterBinds).first();
  return row?.cnt ?? 0;
}

// 全期累计用户增长:按每个 first_seen 日累计,得到一条单调上升曲线。
async function computeGrowth(DB, filterAnd, filterBinds) {
  const rows = await DB.prepare(
    "SELECT date, COUNT(*) AS new_on_day FROM pings WHERE first_seen = 1 " + filterAnd + " GROUP BY date ORDER BY date"
  ).bind(...filterBinds).all();
  const out = [];
  let cum = 0;
  for (const r of rows.results ?? []) {
    cum += r.new_on_day ?? 0;
    out.push({ date: r.date, total: cum, new: r.new_on_day ?? 0 });
  }
  return out;
}

// 增长会计(Growth Accounting,周粒度):
//   new         = 首现日落在本周的设备
//   resurrected = 本周活跃、上周不活跃、且首现早于本周(回流)
//   retained    = 本周与上周都活跃
//   churned     = 上周活跃、本周没回(= 上周 active − 本周 retained,JS 侧推导)
// act CTE 从"目标首周再往前一周"开始取,保证第一周也能和上一周比。
// os/version 走 filterAnd(与 churn 口径一致);segment 不适用于本图(它本身就是
// 用户状态流转分析)。
async function computeGrowthAccounting(DB, startDate, asOf, filterAnd, filterWhere, filterBinds) {
  try {
    const capStart = startDate < addDays(asOf, -181) ? addDays(asOf, -181) : startDate; // 最多 26 周
    const firstWeek = mondayOf(capStart);
    const since = addDays(firstWeek, -7);

    const rows = await DB.prepare(
      "WITH act AS (" +
      "  SELECT DISTINCT device_id, date(date, '-6 days', 'weekday 1') AS wk" +
      "  FROM pings WHERE date >= ? " + filterAnd +
      "), firsts AS (SELECT device_id, MIN(date) AS fd FROM pings " + filterWhere + " GROUP BY device_id) " +
      "SELECT a.wk AS wk, COUNT(*) AS active, " +
      "SUM(CASE WHEN f.fd >= a.wk THEN 1 ELSE 0 END) AS new_users, " +
      "SUM(CASE WHEN f.fd < a.wk AND prev.device_id IS NULL THEN 1 ELSE 0 END) AS resurrected, " +
      "SUM(CASE WHEN prev.device_id IS NOT NULL THEN 1 ELSE 0 END) AS retained " +
      "FROM act a " +
      "JOIN firsts f ON f.device_id = a.device_id " +
      "LEFT JOIN act prev ON prev.device_id = a.device_id AND prev.wk = date(a.wk, '-7 days') " +
      "GROUP BY a.wk ORDER BY a.wk"
    ).bind(since, ...filterBinds, ...filterBinds).all();

    const by = new Map((rows.results ?? []).map((r) => [r.wk, r]));
    const out = [];
    const lastWeek = mondayOf(asOf);
    for (let wk = firstWeek; wk <= lastWeek; wk = addDays(wk, 7)) {
      const cur = by.get(wk) ?? { active: 0, new_users: 0, resurrected: 0, retained: 0 };
      const prevActive = by.get(addDays(wk, -7))?.active ?? 0;
      const churned = Math.max(0, prevActive - (cur.retained ?? 0));
      out.push({
        week: wk,
        newUsers: cur.new_users ?? 0,
        resurrected: cur.resurrected ?? 0,
        retained: cur.retained ?? 0,
        churned,
        active: cur.active ?? 0,
        // Quick Ratio = (新增+复活)/流失;>1 增长,<1 萎缩。流失为 0 时无定义。
        quickRatio: churned > 0 ? Math.round(((cur.new_users ?? 0) + (cur.resurrected ?? 0)) / churned * 10) / 10 : null,
        partial: wk === lastWeek && addDays(wk, 6) > asOf,
      });
    }
    return out;
  } catch (err) {
    console.error("growth accounting error:", err);
    return [];
  }
}

// 每周新增 cohort 首 7 天人均消息:衡量"最近拉来的用户质量是升是降"。
// 只返回全员满龄的周(周内最晚首现日 + 6 天 ≤ asOf ⇔ 周一 + 12 天 ≤ asOf)。
async function computeCohortQuality(DB, asOf) {
  try {
    const since = addDays(asOf, -112); // 16 周窗口
    const rows = await DB.prepare(
      "WITH firsts AS (SELECT device_id, MIN(date) AS fd FROM pings GROUP BY device_id), " +
      "cw AS (SELECT device_id, fd, date(fd, '-6 days', 'weekday 1') AS wk FROM firsts WHERE fd >= ?) " +
      "SELECT cw.wk AS week, COUNT(DISTINCT cw.device_id) AS size, " +
      "ROUND(SUM(p.msg_count) * 1.0 / COUNT(DISTINCT cw.device_id), 1) AS msgs_per_user " +
      "FROM cw JOIN pings p ON p.device_id = cw.device_id AND p.date BETWEEN cw.fd AND date(cw.fd, '+6 days') " +
      "GROUP BY cw.wk ORDER BY cw.wk"
    ).bind(since).all();
    return (rows.results ?? []).filter((r) => addDays(r.week, 12) <= asOf);
  } catch (err) {
    console.error("cohort quality error:", err);
    return [];
  }
}

// 新用户 cohort 留存(批量、全量口径)。
// 用 CTE 把"每设备首现日"只物化一次(firsts/sizes);VALUES 把 5 个 offset 横向展开成
// 笛卡尔积,一条查询拿全所有 (cdate, size, off, 回访数)。LEFT JOIN 保证无回访的 cohort 计 0。
async function computeRetention(DB, asOf, cohortDays) {
  try {
    const since = addDays(asOf, -cohortDays);
    const offsets = [1, 3, 7, 14, 30];

    const rows = await DB.prepare(
      "WITH " +
      "firsts AS (SELECT device_id, MIN(date) AS fd FROM pings GROUP BY device_id), " +
      "sizes  AS (SELECT fd, COUNT(*) AS size FROM firsts GROUP BY fd), " +
      "offs(off) AS (SELECT 1 UNION ALL SELECT 3 UNION ALL SELECT 7 UNION ALL SELECT 14 UNION ALL SELECT 30) " +
      "SELECT f.fd AS cdate, s.size AS size, o.off AS off, COUNT(p.device_id) AS cnt " +
      "FROM firsts f " +
      "JOIN sizes s ON s.fd = f.fd " +
      "CROSS JOIN offs o " +
      "LEFT JOIN pings p ON p.device_id = f.device_id AND p.date = date(f.fd, '+' || o.off || ' day') " +
      "WHERE f.fd >= ? " +
      "GROUP BY f.fd, o.off"
    ).bind(since).all();

    // 按 cohort 聚合回访数;size 同一 cohort 在所有 offset 行上恒定(JOIN sizes 保证)。
    const map = new Map();
    for (const r of rows.results ?? []) {
      if (!map.has(r.cdate)) map.set(r.cdate, { size: r.size, ret: {} });
      map.get(r.cdate).ret[r.off] = r.cnt;
    }

    const result = [];
    for (const [cdate, info] of map) {
      const retention = {};
      for (const off of offsets) {
        if (addDays(cdate, off) > asOf) { retention[off] = null; continue; }
        const cnt = info.ret[off] ?? 0;
        retention[off] = info.size > 0 ? Math.round((cnt / info.size) * 100) : 0;
      }
      result.push({ date: cdate, size: info.size, retention });
    }
    result.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { cohorts: result };
  } catch (err) {
    console.error("retention error:", err);
    return { cohorts: [] };
  }
}

// 全量滚动留存:cohort = 当日全部活跃设备(不限新用户),衡量存量粘性。与
// computeRetention 同构。数值天然高于新用户 cohort(base 本就是已留下来的活跃用户)。
async function computeRollingRetention(DB, asOf, baseDays) {
  try {
    const since = addDays(asOf, -(baseDays - 1));
    const offsets = [1, 3, 7, 14, 30];

    const rows = await DB.prepare(
      "WITH " +
      "base  AS (SELECT device_id, date AS bdate FROM pings WHERE date >= ?), " +
      "sizes AS (SELECT bdate, COUNT(*) AS size FROM base GROUP BY bdate), " +
      "offs(off) AS (SELECT 1 UNION ALL SELECT 3 UNION ALL SELECT 7 UNION ALL SELECT 14 UNION ALL SELECT 30) " +
      "SELECT b.bdate AS bdate, s.size AS size, o.off AS off, COUNT(p.device_id) AS cnt " +
      "FROM base b " +
      "JOIN sizes s ON s.bdate = b.bdate " +
      "CROSS JOIN offs o " +
      "LEFT JOIN pings p ON p.device_id = b.device_id AND p.date = date(b.bdate, '+' || o.off || ' day') " +
      "GROUP BY b.bdate, o.off"
    ).bind(since).all();

    const map = new Map();
    for (const r of rows.results ?? []) {
      if (!map.has(r.bdate)) map.set(r.bdate, { size: r.size, ret: {} });
      map.get(r.bdate).ret[r.off] = r.cnt;
    }

    const result = [];
    for (const [bdate, info] of map) {
      const retention = {};
      for (const off of offsets) {
        if (addDays(bdate, off) > asOf) { retention[off] = null; continue; }
        const cnt = info.ret[off] ?? 0;
        retention[off] = info.size > 0 ? Math.round((cnt / info.size) * 100) : 0;
      }
      result.push({ date: bdate, size: info.size, retention });
    }
    result.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { cohorts: result };
  } catch (err) {
    console.error("rolling retention error:", err);
    return { cohorts: [] };
  }
}

// 把各新用户 cohort 的 D1/D3/D7/D14/D30 按规模加权平均(只取已满龄的)。
function computeAvgRetention(cohorts) {
  const result = { d1: null, d3: null, d7: null, d14: null, d30: null };
  if (!cohorts?.length) return result;
  for (const [key, offset] of [["d1", 1], ["d3", 3], ["d7", 7], ["d14", 14], ["d30", 30]]) {
    const valid = cohorts.filter((c) => c.retention[offset] != null);
    if (!valid.length) continue;
    const totalUsers = valid.reduce((s, c) => s + c.size, 0);
    const weighted = valid.reduce((s, c) => s + c.retention[offset] * c.size, 0);
    result[key] = totalUsers > 0 ? Math.round(weighted / totalUsers) : null;
  }
  return result;
}

// 流失 / 复活:近 7 天 = [asOf-7, asOf-1](排除可能未结束的 asOf),前 7 天 = [asOf-14, asOf-8]。
//   retained   = 两窗都活跃
//   churned    = 前窗活跃、最近没回(流失)
//   resurrected= 最近活跃、前窗不在、但更早出现过(复活)
async function computeChurn(DB, asOf, filterAnd, filterBinds) {
  try {
    const rStart = addDays(asOf, -7), rEnd = addDays(asOf, -1);
    const pStart = addDays(asOf, -14), pEnd = addDays(asOf, -8);
    const before = addDays(asOf, -15);
    // 四条互不依赖,并行。
    const [recentQ, priorQ, retainedQ, resurrectedQ] = await Promise.all([
      DB.prepare(
        "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd
      ).bind(rStart, rEnd, ...filterBinds).first(),
      DB.prepare(
        "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd
      ).bind(pStart, pEnd, ...filterBinds).first(),
      DB.prepare(
        "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd +
        " AND device_id IN (SELECT device_id FROM pings WHERE date BETWEEN ? AND ? " + filterAnd + ")"
      ).bind(pStart, pEnd, ...filterBinds, rStart, rEnd, ...filterBinds).first(),
      DB.prepare(
        "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd +
        " AND device_id NOT IN (SELECT device_id FROM pings WHERE date BETWEEN ? AND ? " + filterAnd + ")" +
        " AND device_id IN (SELECT device_id FROM pings WHERE date < ? " + filterAnd + ")"
      ).bind(rStart, rEnd, ...filterBinds, pStart, pEnd, ...filterBinds, before, ...filterBinds).first(),
    ]);
    const recent = recentQ?.c ?? 0, prior = priorQ?.c ?? 0, retained = retainedQ?.c ?? 0, resurrected = resurrectedQ?.c ?? 0;
    return {
      recent, prior, retained, resurrected,
      churned: Math.max(0, prior - retained),
      churnRate: prior > 0 ? Math.round((prior - retained) / prior * 100) : null,
    };
  } catch (err) {
    console.error("churn error:", err);
    return null;
  }
}

// 活跃用户当日消息数的分位(中位 / P90 / 均值)。窗口由调用方限定并排除今天。
async function computePercentiles(DB, start, end, filterAnd, filterBinds) {
  try {
    const rows = await DB.prepare(
      "SELECT msg_count FROM pings WHERE date BETWEEN ? AND ? AND msg_count > 0 " + filterAnd + " ORDER BY msg_count"
    ).bind(start, end, ...filterBinds).all();
    const arr = (rows.results ?? []).map((r) => r.msg_count);
    if (!arr.length) return { count: 0, median: 0, p90: 0, mean: 0 };
    const sum = arr.reduce((s, n) => s + n, 0);
    return {
      count: arr.length,
      median: arr[Math.floor(arr.length / 2)],
      p90: arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.9))],
      mean: Math.round((sum / arr.length) * 10) / 10,
    };
  } catch (err) {
    console.error("percentiles error:", err);
    return null;
  }
}
