// 遥测看板冒烟:用 bun:sqlite 模拟 D1,端到端调用 functions/ 下三个端点。
//   bun run scripts/smoke-dashboard.ts   (在 pc-server 目录下)
//
// 覆盖:
//   - ping:参数校验、日期钳制 ±1 天、无变化心跳只花 1 次读、version_dist 条件重建
//   - rebuild:405(GET)、first_seen 全量矫正、缓存表重建
//   - stats:鉴权(token/cookie)、补零趋势、增长会计/PowerCurve/粘性/新用户质量、
//            筛选组合的 bind 对齐、days 钳制
//   - dashboard:302 下发 cookie、CSP/nonce、内嵌 JS 语法(new Function 编译)
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const { onRequest: pingHandler } = await import(join(root, "functions", "ping.ts"));
const { onRequest: statsHandler } = await import(join(root, "functions", "api", "stats", "index.ts"));
const { onRequest: rebuildHandler } = await import(join(root, "functions", "api", "admin", "rebuild.ts"));
const { onRequest: dashHandler } = await import(join(root, "functions", "dashboard.ts"));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log("  ok  " + name); }
  else { failures++; console.error("FAIL  " + name + (detail !== undefined ? "  →  " + JSON.stringify(detail) : "")); }
}

// ── D1 shim over bun:sqlite ──
const db = new Database(":memory:");
const sqlLog: string[] = [];
function d1() {
  const make = (sql: string, args: unknown[]) => ({
    async all() { sqlLog.push(sql); return { results: db.query(sql).all(...(args as never[])) }; },
    async first() { sqlLog.push(sql); return db.query(sql).get(...(args as never[])) ?? null; },
    async run() { sqlLog.push(sql); db.query(sql).run(...(args as never[])); return { success: true }; },
  });
  return {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => make(sql, args), ...make(sql, []) };
    },
  };
}

const schema = readFileSync(join(root, "functions", "_sql", "schema.sql"), "utf-8");
for (const stmt of schema.split(";")) {
  const meaningful = stmt.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
  if (meaningful) db.run(stmt);
}

const TOKEN = "test-secret-token";
const DB = d1();
const waitTasks: Promise<unknown>[] = [];
function ctx(url: string, init?: RequestInit & { cookie?: string; country?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("Cookie", init.cookie);
  const request = new Request(url, { ...init, headers });
  // workerd 的 Request 自带 cf 对象,测试里手工挂一个等价物
  if (init?.country) (request as unknown as { cf: { country: string } }).cf = { country: init.country };
  return {
    env: { DB, AUTH_TOKEN: TOKEN },
    request,
    waitUntil: (p: Promise<unknown>) => waitTasks.push(p),
  };
}
async function flushWaits() { await Promise.all(waitTasks.splice(0)); }

const BASE = "https://dash.example";
const utcToday = new Date().toISOString().slice(0, 10);
function addDays(s: string, n: number) {
  const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── 种子数据:60 天、多种生命周期形态(直接写库,first_seen 之后由 rebuild 矫正)──
// hb/err/feat/country 给核心设备一些非零值,让质量/功能/地区查询有数据可断言。
const ins = db.query(
  "INSERT OR REPLACE INTO pings (device_id, date, version, os, msg_count, first_seen, country, hb_count, err_count, feat_search, feat_tts, feat_mcp, feat_img) " +
  "VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0)"
);
const seed = (id: string, date: string, ver: string, os: string, mc: number, extras?: { cc?: string; hb?: number; er?: number; fs?: number; fm?: number }) =>
  ins.run(id, date, ver, os, mc, extras?.cc ?? "", extras?.hb ?? 0, extras?.er ?? 0, extras?.fs ?? 0, extras?.fm ?? 0);
const oses = ["win", "linux", "mac"];
for (let i = 59; i >= 0; i--) {
  const date = addDays(utcToday, -i);
  const ver = i > 20 ? "1.4.0" : "1.4.1";
  // 全勤重度用户带完整新遥测:国家码、心跳 30 跳(≈300 分钟)、少量失败、搜索/MCP 使用
  for (let c = 0; c < 6; c++) seed("core-device-" + c + "-aaaaaaaaaaaa", date, ver, oses[c % 3], 25, { cc: c % 2 ? "US" : "CN", hb: 30, er: c === 0 ? 1 : 0, fs: 2, fm: c % 3 === 0 ? 1 : 0 });
  if (i > 30) for (let c = 0; c < 8; c++) seed("churned-device-" + c + "-bbbbbbbb", date, "1.4.0", oses[c % 3], 4); // 30 天前流失(旧客户端,无新遥测)
  for (let n = 0; n < 2; n++) {
    const id = "newdev-" + date + "-" + n + "-cccccccc";
    seed(id, date, ver, oses[n % 3], n === 0 ? 3 : 0);                       // 每天 2 个新设备
    if (n === 0) for (const off of [1, 3, 7]) { const back = addDays(date, off); if (back <= utcToday) seed(id, back, ver, oses[0], 2); } // 其一按 D+1/3/7 回访
  }
}
// 一批复活设备:45 天前活跃过、近 3 天回来
for (let c = 0; c < 3; c++) {
  seed("resur-device-" + c + "-dddddddddddd", addDays(utcToday, -45), "1.4.0", "win", 2);
  seed("resur-device-" + c + "-dddddddddddd", addDays(utcToday, -1), "1.4.1", "win", 5);
}

// ── rebuild ──
console.log("[rebuild]");
{
  const resGet = await rebuildHandler(ctx(BASE + "/api/admin/rebuild?token=" + TOKEN, { method: "GET" }));
  check("GET 被拒 405", resGet.status === 405);
  const res401 = await rebuildHandler(ctx(BASE + "/api/admin/rebuild?token=wrong", { method: "POST" }));
  check("坏 token 401", res401.status === 401);
  const res = await rebuildHandler(ctx(BASE + "/api/admin/rebuild?token=" + TOKEN, { method: "POST" }));
  const body = await res.json();
  check("POST 重建成功", res.status === 200 && body.ok === true, body);
  const bad = db.query("SELECT device_id FROM pings GROUP BY device_id HAVING SUM(first_seen) != 1").all();
  check("每设备恰好一行 first_seen=1", bad.length === 0, bad.slice(0, 3));
  const days = db.query("SELECT COUNT(*) AS c FROM daily_summary").get() as { c: number };
  check("daily_summary 已重建", days.c >= 59, days);
}

// ── ping ──
console.log("[ping]");
{
  let res = await pingHandler(ctx(BASE + "/ping?id=zz&d=" + utcToday));
  check("坏 id 400", res.status === 400);
  res = await pingHandler(ctx(BASE + "/ping?id=abcdef0123456789abcdef01&d=2020-01-01"));
  check("历史日期被钳制 400", res.status === 400);
  res = await pingHandler(ctx(BASE + "/ping?id=abcdef0123456789abcdef01&d=" + addDays(utcToday, 5)));
  check("未来日期被钳制 400", res.status === 400);
  res = await pingHandler(ctx(BASE + "/ping?id=abcdef0123456789abcdef01&d=2026-13-45"));
  check("非法日历日期 400", res.status === 400);

  const pingUrl = BASE + "/ping?id=abcdef0123456789abcdef01&d=" + utcToday + "&v=9.9.9&os=win&mc=5";
  res = await pingHandler(ctx(pingUrl));
  await flushWaits();
  check("新设备 ping 落库", res.status === 200 && (await res.json()).ok === true);
  const row = db.query("SELECT * FROM pings WHERE device_id = 'abcdef0123456789abcdef01'").get() as Record<string, unknown>;
  check("first_seen=1 / mc=5", row?.first_seen === 1 && row?.msg_count === 5, row);
  check("version_dist 含新版本", (db.query("SELECT count FROM version_dist WHERE date = ? AND version = '9.9.9'").get(utcToday) as { count: number })?.count === 1);

  sqlLog.length = 0;
  res = await pingHandler(ctx(pingUrl)); // 完全相同的心跳
  await flushWaits();
  check("无变化心跳只花 1 次读", res.status === 200 && sqlLog.length === 1, sqlLog);

  sqlLog.length = 0;
  res = await pingHandler(ctx(pingUrl.replace("mc=5", "mc=9"))); // 只有 mc 变
  await flushWaits();
  const hasVdRebuild = sqlLog.some((s) => s.includes("DELETE FROM version_dist"));
  check("mc 增长触发汇总但跳过 version_dist", res.status === 200 && !hasVdRebuild && sqlLog.length >= 3, sqlLog);
  res = await pingHandler(ctx(pingUrl.replace("mc=5", "mc=2"))); // mc 回落:MAX 语义,不算变化
  await flushWaits();
  const mcRow = db.query("SELECT msg_count FROM pings WHERE device_id = 'abcdef0123456789abcdef01'").get() as { msg_count: number };
  check("mc 回落不覆盖(保持 9)", mcRow.msg_count === 9, mcRow);

  // 扩展遥测:hb/er/功能计数 + CF 国家码
  const extUrl = pingUrl.replace("mc=5", "mc=9") + "&hb=3&er=1&fs=2&ft=1&fm=4&fi=1";
  sqlLog.length = 0;
  res = await pingHandler(ctx(extUrl, { country: "JP" }));
  await flushWaits();
  const extRow = db.query("SELECT country, hb_count, err_count, feat_search, feat_tts, feat_mcp, feat_img FROM pings WHERE device_id = 'abcdef0123456789abcdef01'").get() as Record<string, unknown>;
  check("扩展遥测落库", extRow.country === "JP" && extRow.hb_count === 3 && extRow.err_count === 1 && extRow.feat_search === 2 && extRow.feat_tts === 1 && extRow.feat_mcp === 4 && extRow.feat_img === 1, extRow);
  check("hb/feat 变化不触发汇总刷新", !sqlLog.some((s) => s.includes("daily_summary")) && !sqlLog.some((s) => s.includes("version_dist")), sqlLog);

  sqlLog.length = 0;
  res = await pingHandler(ctx(extUrl.replace("hb=3", "hb=4"), { country: "JP" })); // 纯心跳 +1
  await flushWaits();
  check("纯心跳只花 1 读 + 1 写", sqlLog.length === 2, sqlLog);
}

// ── stats ──
console.log("[stats]");
{
  let res = await statsHandler(ctx(BASE + "/api/stats?days=30"));
  check("无凭证 401", res.status === 401);
  res = await statsHandler(ctx(BASE + "/api/stats?days=30", { cookie: "dash_auth=" + TOKEN }));
  check("cookie 鉴权通过", res.status === 200);
  const d = await res.json();

  const t = d.trends ?? [];
  check("trends 30 天补零连续", t.length === 30 && t.every((r: { date: string }, i: number) => i === 0 || r.date === addDays(t[i - 1].date, 1)), t.length);
  check("KPI 数值健全", d.wau > 0 && d.mau >= d.wau && d.totalUsers > 0, { wau: d.wau, mau: d.mau, total: d.totalUsers });
  const osSum = d.osDist.win + d.osDist.mac + d.osDist.linux + d.osDist.other;
  const verSum = d.versions.reduce((s: number, v: { count: number }) => s + v.count, 0);
  check("osDist/versions 与累计用户一致", osSum === d.totalUsers && verSum === d.totalUsers, { osSum, verSum, total: d.totalUsers });
  check("留存 cohort 非空且 D+1 有值", d.retention.cohorts.length > 0 && d.retention.cohorts.some((c: { retention: Record<string, number> }) => c.retention[1] != null));
  check("加权留存曲线有值", d.avgRetention.d1 != null && d.avgRetention.d7 != null, d.avgRetention);

  const ga = d.growthAccounting ?? [];
  check("增长会计非空、字段完整", ga.length >= 4 && ga.every((w: Record<string, number>) => w.newUsers >= 0 && w.churned >= 0 && w.retained >= 0), ga.length);
  check("增长会计能看到复活", ga.some((w: { resurrected: number }) => w.resurrected > 0), ga.map((w: { resurrected: number }) => w.resurrected));
  const pc = d.powerCurve ?? [];
  const pcSum = pc.reduce((s: number, r: { devices: number }) => s + r.devices, 0);
  const distinct30 = (db.query("SELECT COUNT(DISTINCT device_id) AS c FROM pings WHERE date BETWEEN ? AND ?").get(addDays(utcToday, -29), utcToday) as { c: number }).c;
  check("PowerCurve 设备数对账", pcSum === distinct30, { pcSum, distinct30 });
  const st = d.stickinessTrend ?? [];
  check("粘性趋势有值且 ≤100", st.length > 0 && st.every((r: { dauMau: number; dauWau: number }) => r.dauMau <= 100 && r.dauWau <= 100), st.length);
  check("粘性趋势带 DAU/MAU 规模字段", st.every((r: { dau: number; mau: number }) => r.dau > 0 && r.mau >= r.dau), st[0]);
  const cq = d.cohortQuality ?? [];
  check("新用户质量仅含满龄周", cq.length > 0 && cq.every((r: { week: string }) => addDays(r.week, 12) <= d.filter.asOf), cq);

  // 新遥测聚合
  const fu = d.featureUse ?? {};
  check("功能使用度:搜索/MCP 有设备、base 合理", fu.base > 0 && fu.search >= 6 && fu.mcp >= 1 && fu.chat > 0, fu);
  const qt = d.qualityTrend ?? [];
  check("质量趋势:有失败数与时长估算", qt.length > 0 && qt.some((r: { errs: number }) => r.errs > 0) && qt.some((r: { avg_minutes: number }) => r.avg_minutes === 300), qt.slice(-2));
  const cdist = d.countryDist ?? [];
  const cn = cdist.find((r: { country: string }) => r.country === "CN");
  const us = cdist.find((r: { country: string }) => r.country === "US");
  check("地区分布:CN/US 各 3 台核心设备", cn?.count === 3 && us?.count === 3, cdist);
  const pt = d.prevTrends ?? [];
  check("期间对比:上一窗口等长且日期紧邻", pt.length === t.length && addDays(pt[pt.length-1].date, 1) === t[0].date, { prev: pt.length, cur: t.length });

  // 筛选组合(bind 对齐回归)
  for (const q of ["os=win", "version=1.4.1", "segment=new", "os=linux&version=1.4.1&segment=returning", "days=-5", "days=abc", "start=" + addDays(utcToday, -10) + "&end=" + utcToday]) {
    const r = await statsHandler(ctx(BASE + "/api/stats?" + q, { cookie: "dash_auth=" + TOKEN }));
    check("筛选 " + q + " → 200", r.status === 200, r.status);
  }
}

// ── dashboard ──
console.log("[dashboard]");
{
  let res = await dashHandler(ctx(BASE + "/dashboard"));
  check("无凭证 401", res.status === 401);
  res = await dashHandler(ctx(BASE + "/dashboard?token=" + TOKEN));
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  check("token 换 302 + HttpOnly cookie", res.status === 302 && setCookie.includes("HttpOnly") && !(res.headers.get("Location") ?? "").includes("token"), { loc: res.headers.get("Location"), setCookie });
  res = await dashHandler(ctx(BASE + "/dashboard", { cookie: "dash_auth=" + TOKEN }));
  check("cookie 载入页面", res.status === 200);
  const html = await res.text();
  check("CSP 头存在且含 nonce", (res.headers.get("Content-Security-Policy") ?? "").includes("'nonce-"));
  check("nonce 已注入模板", !html.includes("__NONCE__") && /<script nonce="[a-f0-9]{32}">/.test(html));
  check("chart.js 带 SRI", html.includes('integrity="sha384-'));

  check("新章节与新图表已挂到页面", html.includes("功能与质量") && html.includes("renderQuality") && html.includes("cmp-toggle") && html.includes("geo-pie") && html.includes("user-pager"), null);
  check("今日档已移除", !html.includes('data-d="1"'));

  const m = html.match(/<script nonce="[a-f0-9]{32}">([\s\S]*?)<\/script>/);
  check("提取到内嵌脚本", !!m);
  if (m) {
    try { new Function(m[1]); check("内嵌 JS 语法编译通过", true); }
    catch (e) { check("内嵌 JS 语法编译通过", false, String(e)); }
  }
}

console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
