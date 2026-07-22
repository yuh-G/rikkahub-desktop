// GET /api/stats?token=...&days=30&os=all&version=all&segment=all&start=&end=
//
// 看板数据接口。本文件曾有几处严重缺陷,一并修复:
//   1) 鉴权:此前完全无 token 校验,任何人都能拉走全部统计(设备列表/版本/OS/消息数)。
//   2) 性能:daily_summary 与 version_dist 两张缓存表一直被 ping.ts 的 refreshDay
//      在写、却从未被读,每次都全量扫 pings。现在无筛选时 trends / versionTrend
//      改读这两张表(数量级提速);筛选时才回退 pings 实时聚合。
//   3) 正确性:留存照搬了旧版的 LIMIT 30,把窗口扩到 60 天却忘了同步,恰好砍掉
//      唯一能满龄 D+30 的 cohort;滚动留存 baseDays=14 连 D+14 都满不了龄;流失率
//      窗口含"未结束的今天"导致虚高;versions/osDist 按"当日活跃"算,样本小波动大。
//   4) 留存 N+1:原 cohort×offset 逐条查询最多 150+ 次 D1 往返,改 CTE 一次展开。
//   5) 串行往返:15+ 个独立查询原先逐个 await,改 Promise.all 并行发起。
export const onRequest = async (context) => {
  const url = new URL(context.request.url);

  // ── 鉴权(此前缺失)──
  if (!context.env.AUTH_TOKEN || url.searchParams.get("token") !== context.env.AUTH_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const DB = context.env.DB;
  const daysRaw = url.searchParams.get("days") ?? "30";
  // days 可能是非法值(直接拼 URL 如 ?days=foo):parseInt 得 NaN,会一路污染 addDays
  // 产生 "Invalid Date",让 BETWEEN 查空。NaN 回退默认 30 天。
  const parsedDays = parseInt(daysRaw, 10);
  const daysParam = daysRaw === "all" ? 99999 : (Number.isFinite(parsedDays) ? Math.min(parsedDays, 365) : 30);
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
    const today = endParam && /^\d{4}-\d{2}-\d{2}$/.test(endParam) ? endParam : (latestRow?.d ?? new Date().toISOString().slice(0, 10));
    const days = startParam && /^\d{4}-\d{2}-\d{2}$/.test(startParam)
      ? Math.max(1, Math.round((new Date(today) - new Date(startParam)) / 86400000) + 1)
      : daysParam;

    let startDate;
    if (startParam && /^\d{4}-\d{2}-\d{2}$/.test(startParam)) {
      startDate = startParam;
    } else if (daysRaw === "all") {
      const minRow = await DB.prepare("SELECT MIN(date) AS d FROM pings" + filterWhere).bind(...filterBinds).first();
      startDate = minRow?.d ?? today;
    } else {
      startDate = addDays(today, -(days - 1));
    }

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

    // 下面这些查询彼此独立(都只依赖 startDate/today/allAnd/allBinds 等已就绪的变量),
    // 用 Promise.all 并行发起,把原先 15+ 次串行往返(每次 20-50ms RTT)压到一两跳。
    const [
      trendsRaw, wau, mau, totalRow, buckets, versions, osDistRow,
      versionTrend, growth, retention, rollingRetention, churn, percentiles, recentUsers
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
      // 版本分布:全量用户"最新一次上报"的版本。刻意不叠筛选——这是全量用户的稳定
      // 快照(按全部用户而非当日活跃),用于版本下拉与分布饼图;每日采用趋势见 versionTrend。
      DB.prepare(
        "SELECT version, COUNT(*) AS count FROM (" +
        "  SELECT device_id, version, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY date DESC, created_at DESC) AS rn FROM pings" +
        ") WHERE rn = 1 GROUP BY version ORDER BY count DESC"
      ).all(),
      // 系统分布:全量用户最新一次上报的系统。
      DB.prepare(
        "SELECT " +
        "SUM(CASE WHEN os = 'win' THEN 1 ELSE 0 END) AS win, " +
        "SUM(CASE WHEN os = 'mac' THEN 1 ELSE 0 END) AS mac, " +
        "SUM(CASE WHEN os = 'linux' THEN 1 ELSE 0 END) AS linux, " +
        "SUM(CASE WHEN os NOT IN ('win','mac','linux') THEN 1 ELSE 0 END) AS other " +
        "FROM (SELECT device_id, os, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY date DESC, created_at DESC) AS rn FROM pings) WHERE rn = 1"
      ).first(),
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
        "FROM pings p WHERE 1=1 " + allAnd + " GROUP BY device_id ORDER BY last_date DESC, total_msgs DESC LIMIT 50"
      ).bind(...allBinds).all(),
    ]);

    const trends = trendsRaw.results ?? [];
    const todayRow = trends[trends.length - 1] ?? {};
    const dau = todayRow?.dau ?? 0;
    const stickinessMau = mau > 0 ? Math.round((dau / mau) * 100) : 0;
    const stickinessWau = wau > 0 ? Math.round((dau / wau) * 100) : 0;
    const totalUsers = totalRow?.cnt ?? 0;
    // avgRetention 依赖 retention 结果,须在并行结束后算。
    const avgRetention = computeAvgRetention(retention.cohorts);

    return new Response(JSON.stringify({
      trends,
      wau, mau,
      stickiness: stickinessMau,
      stickinessMau, stickinessWau,
      totalUsers,
      depth: { b0: buckets?.b0 ?? 0, b1_5: buckets?.b1_5 ?? 0, b6_20: buckets?.b6_20 ?? 0, b20p: buckets?.b20p ?? 0 },
      versions: versions.results ?? [],
      osDist: { win: osDistRow?.win ?? 0, mac: osDistRow?.mac ?? 0, linux: osDistRow?.linux ?? 0, other: osDistRow?.other ?? 0 },
      avgRetention,
      retention,
      rollingRetention,
      growth,
      recentUsers: recentUsers.results ?? [],
      churn,
      percentiles,
      versionTrend: versionTrend.results ?? [],
      filter: { os: osFilter, version: verFilter, segment, range: daysRaw, startDate, asOf: today },
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    console.error("stats error:", err);
    // 不把后端错误细节透出到页面。
    return new Response(JSON.stringify({ error: "stats failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
};

// 日期字符串加减天数(全程 UTC,避免本地时区污染 "YYYY-MM-DD")。
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
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

// 新用户 cohort 留存(批量、全量口径)。
// 用 CTE 把"每设备首现日"只物化一次(firsts/sizes);VALUES 把 5 个 offset 横向展开成
// 笛卡尔积,一条查询拿全所有 (cdate, size, off, 回访数)。替代旧版 5 段 UNION ALL——
// 那段里每个 offset 都重新跑一遍 SELECT MIN(date) FROM pings GROUP BY device_id 的
// 全表聚合,等于把同一份首现日算了 5 遍。LEFT JOIN 保证无回访的 cohort 计 0。
async function computeRetention(DB, asOf, cohortDays) {
  try {
    const since = addDays(asOf, -cohortDays);
    const offsets = [1, 3, 7, 14, 30];

    const rows = await DB.prepare(
      "WITH " +
      "firsts AS (SELECT device_id, MIN(date) AS fd FROM pings GROUP BY device_id), " +
      "sizes  AS (SELECT fd, COUNT(*) AS size FROM firsts GROUP BY fd) " +
      "SELECT f.fd AS cdate, s.size AS size, o.off AS off, COUNT(p.device_id) AS cnt " +
      "FROM firsts f " +
      "JOIN sizes s ON s.fd = f.fd " +
      "CROSS JOIN (VALUES (1),(3),(7),(14),(30)) AS o(off) " +
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
// computeRetention 同构——CTE base/sizes 各算一次,VALUES 展开 5 个 offset,一条查询
// 拿全 (bdate, size, off, cnt)。同样批量,数值天然高于新用户 cohort(base 本就是
// 已留下来的活跃用户),偏高属正常。
async function computeRollingRetention(DB, asOf, baseDays) {
  try {
    const since = addDays(asOf, -(baseDays - 1));
    const offsets = [1, 3, 7, 14, 30];

    const rows = await DB.prepare(
      "WITH " +
      "base  AS (SELECT device_id, date AS bdate FROM pings WHERE date >= ?), " +
      "sizes AS (SELECT bdate, COUNT(*) AS size FROM base GROUP BY bdate) " +
      "SELECT b.bdate AS bdate, s.size AS size, o.off AS off, COUNT(p.device_id) AS cnt " +
      "FROM base b " +
      "JOIN sizes s ON s.bdate = b.bdate " +
      "CROSS JOIN (VALUES (1),(3),(7),(14),(30)) AS o(off) " +
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
    const recentQ = await DB.prepare(
      "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd
    ).bind(rStart, rEnd, ...filterBinds).first();
    const priorQ = await DB.prepare(
      "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd
    ).bind(pStart, pEnd, ...filterBinds).first();
    const retainedQ = await DB.prepare(
      "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd +
      " AND device_id IN (SELECT device_id FROM pings WHERE date BETWEEN ? AND ? " + filterAnd + ")"
    ).bind(pStart, pEnd, ...filterBinds, rStart, rEnd, ...filterBinds).first();
    const resurrectedQ = await DB.prepare(
      "SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ? " + filterAnd +
      " AND device_id NOT IN (SELECT device_id FROM pings WHERE date BETWEEN ? AND ? " + filterAnd + ")" +
      " AND device_id IN (SELECT device_id FROM pings WHERE date < ? " + filterAnd + ")"
    ).bind(rStart, rEnd, ...filterBinds, pStart, pEnd, ...filterBinds, before, ...filterBinds).first();
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
