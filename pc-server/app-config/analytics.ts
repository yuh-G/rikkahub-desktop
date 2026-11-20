// app-config/analytics.ts — 匿名 DAU 统计（一启动一 ping，绝不打扰用户，详见下方设计准则注释）
// 纪律：搬迁自 server.ts（阶段 5.3h）。仅发送当日计数——设备 UUID、日期、版本、OS,外加:
//   mc = 消息数        hb = 有活动的 10 分钟 tick 数  am = 活跃分钟数(见 markUiActivity)
//   er = provider 失败  fs/ft/fm/fi = 搜索 / TTS / MCP / 图像生成 使用次数
// 不采集用户内容、IP、模型名、文件名、查询词。服务端只按 MAX 合并当日计数,每天归零。

import { readFileSync, writeFileSync } from "node:fs";
import { deviceIdPath } from "../foundation/paths";
import { APP_VERSION } from "../updates/index";

// 上报开关(假新用户/假日活专题)。开发态冒烟测试把 RIKKAHUB_PC_DATA_DIR 指到一次性
// 临时目录,每次跑都生成全新 device-id + 无条件 startup ping → 一次 spawn 就记一个
// "新用户",dashboard 日活被人为刷爆。门控让"是否上报"由"这是不是真实安装"决定:
//   RIKKAHUB_ANALYTICS=1/0 显式指定,优先级最高(调试/紧急关停);
//   否则编译出来的 exe(bun build --compile 产物,用户真实安装)默认上报;
//   源码 `bun run server.ts`(开发/冒烟/CI)默认不上报。
export function analyticsEnabled(): boolean {
  const explicit = process.env.RIKKAHUB_ANALYTICS;
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  return runningAsStandaloneExecutable();
}

// 单文件 exe 判定。**不能用 argv 判**:初版门控假设"编译 exe 的 argv 不含入口脚本
// 路径",实测反了——standalone 下 argv[0] 被硬编码成 "bun"、argv[1] 恰恰是 bunfs 虚拟
// 入口路径(B:/~BUN/root/<name>),用户参数从 argv[2] 起。于是两态都被判成源码态,
// 2.0.0-preview 整个版本零上报(看板上该版本采用曲线彻底缺失,发现于 2026-09-11)。
// 现在用官方 API,并保留一道 bunfs 入口前缀兜底:该属性 Bun 1.4.0 才有,旧 bun 上是
// undefined——若某天在旧运行时上编译,兜底能防止再次静默变哑(哑掉无任何报错信号)。
function runningAsStandaloneExecutable(): boolean {
  if (typeof Bun.isStandaloneExecutable === "boolean") return Bun.isStandaloneExecutable;
  return /^(?:[A-Za-z]:[\\/]~BUN[\\/]|\/\$bunfs\/)/.test(Bun.main ?? "");
}

const ANALYTICS_ENDPOINT = "https://rikkahub-desktop.pages.dev/ping";
let analyticsDeviceId = "";
let analyticsMsgCount = 0;
let analyticsHbCount = 0;      // 心跳数:活跃 tick +1,≈ 当日【窗口激活】时长 / 10 分钟
let analyticsErrCount = 0;     // provider 请求失败数(不含用户主动中断)
let analyticsSearchCount = 0;  // search_web / scrape_web 执行次数
let analyticsTtsCount = 0;     // TTS 朗读次数
let analyticsMcpCount = 0;     // MCP 工具调用次数
let analyticsImgCount = 0;     // 图像生成次数
let analyticsEngineRestartCount = 0; // 引擎宿主进程意外退出后的自动重启次数(P7.2.7)

// 专题6:使用时长的口径是"用户实际在用"而非"进程在线"。此前 hb 每次 ping 无条件
// +1,而 ping 只要 server 进程活着就发——托盘常驻/Docker 7×24 部署把"使用时长"灌成
// "进程在线时长"(dashboard 曾出现日均 645 分钟的荒谬均值)。现在由前端在窗口可见
// 且聚焦时上报活动信标(POST /api/activity → markUiActivity):
//   am = 累计的活跃分钟数(分钟级精度,dashboard 优先采用)
//   hb = 收到过信标的 10 分钟 tick 数(粗粒度,兼容老 dashboard 的 hb×10 估算)
// 无 UI 交互的空转进程两者恒为 0。
// C3(专题6复查):升级为前端权威计量——信标携带自上一拍以来的真实聚焦毫秒数,
// 后端只做钳制累加。旧的"到达间隔≤90s 全额计 + 突发首拍固定记 60s"启发式在
// 碎片化使用(频繁切窗)下高估可达 2 倍:失焦 30s 再回来,间隔全额入账;聚焦 1 秒
// 也记满 60s。真实聚焦时长只有前端知道,后端启发式再精也只是猜。
let lastUiActivityAt = 0;
let analyticsActiveSeconds = 0;

/** 一拍学分钳制(纯函数,供测试)。正常拍 ≤60s+定时器抖动;90s 上限防时钟异常、
 *  睡眠唤醒后的超长段、或畸形请求膨胀计数。非法输入记 0。 */
export function beaconCreditSeconds(focusedMs: number): number {
  if (!Number.isFinite(focusedMs)) return 0;
  return Math.min(Math.max(focusedMs / 1000, 0), 90);
}

export function markUiActivity(focusedMs: number): void {
  analyticsActiveSeconds += beaconCreditSeconds(focusedMs);
  lastUiActivityAt = Date.now();
}

// 3.5c-4: 埋点分散在各域模块(会话/工具/媒体),经函数递增计数(let 变量无法跨模块赋值)。
export function bumpAnalyticsMsgCount() { analyticsMsgCount++; }
export function bumpAnalyticsErrCount() { analyticsErrCount++; }
export function bumpAnalyticsSearchCount() { analyticsSearchCount++; }
export function bumpAnalyticsTtsCount() { analyticsTtsCount++; }
export function bumpAnalyticsMcpCount() { analyticsMcpCount++; }
export function bumpAnalyticsImgCount() { analyticsImgCount++; }
export function bumpAnalyticsEngineRestartCount() { analyticsEngineRestartCount++; }

function resetAnalyticsCounters(): void {
  analyticsMsgCount = 0;
  analyticsHbCount = 0;
  analyticsActiveSeconds = 0;
  analyticsErrCount = 0;
  analyticsSearchCount = 0;
  analyticsTtsCount = 0;
  analyticsMcpCount = 0;
  analyticsImgCount = 0;
  analyticsEngineRestartCount = 0;
}

function readOrCreateDeviceId(): string {
  try { return readFileSync(deviceIdPath, "utf-8").trim(); } catch { /* not found */ }
  const id = crypto.randomUUID();
  try { writeFileSync(deviceIdPath, id); } catch { /* best-effort */ }
  return id;
}

function localDateStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function analyticsOs(): string {
  // 区分 win / mac / linux —— Docker 容器内 process.platform === "linux",
  // 算 Linux 用户,合理(Docker 镜像也是基于 Linux 二进制)。
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux") return "linux";
  return "win";
}

function sendAnalyticsPing(): void {
  if (!analyticsDeviceId) return;
  const url = `${ANALYTICS_ENDPOINT}?id=${encodeURIComponent(analyticsDeviceId)}`
    + `&d=${localDateStr()}`
    + `&v=${encodeURIComponent(APP_VERSION)}`
    + `&os=${analyticsOs()}`
    + `&mc=${analyticsMsgCount}`
    + `&hb=${analyticsHbCount}`
    + `&am=${Math.round(analyticsActiveSeconds / 60)}`
    + `&er=${analyticsErrCount}`
    + `&fs=${analyticsSearchCount}`
    + `&ft=${analyticsTtsCount}`
    + `&fm=${analyticsMcpCount}`
    + `&fi=${analyticsImgCount}`
    + `&rs=${analyticsEngineRestartCount}`;
  // 三重静默防御:
  //   (1) try/catch 包裹同步部分,防 fetch() 同步抛错(比如 URL 不合法)
  //   (2) AbortSignal.timeout 限制网络等待,DNS 失败/连接超时都会被吞
  //   (3) .then/.catch 双 noop 确保 promise 既不打印未捕获 reject,也不让
  //       响应体引起任何后续处理
  try {
    fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) })
      .then(() => {}, () => {});
  } catch { /* fire-and-forget — never block, never warn */ }
}

export function startAnalytics(): void {
  // 门控在 try 之外判定也要兜进 try——analytics 永远不应该让 server 启动失败。
  // 但门控本身是纯函数不抛错,放前面早退,禁用时不做读盘/设 interval 任何动作。
  if (!analyticsEnabled()) return;
  // 同步部分(读 device-id、设置 interval)绝不可能抛错;唯一可能的失败点是
  // fetch,已在 sendAnalyticsPing 内部隔离。这里整体再加一层 try/catch 兜底,
  // 防御未来代码改动时引入意外异常 —— analytics 永远不应该让 server 启动失败。
  try {
    analyticsDeviceId = readOrCreateDeviceId();
    const today = localDateStr();
    let lastDate = today;
    sendAnalyticsPing(); // startup ping(DAU 信号,不计时长——启动 ≠ 在用)
    let lastTickAt = Date.now();
    setInterval(() => {
      const now = localDateStr();
      if (now !== lastDate) { resetAnalyticsCounters(); lastDate = now; }
      // 本 tick 周期内有 UI 活动信标才算一跳(10 分钟粒度的激活时长估算)。
      if (lastUiActivityAt >= lastTickAt) analyticsHbCount++;
      lastTickAt = Date.now();
      sendAnalyticsPing();
    }, 10 * 60 * 1000); // every 10 minutes
  } catch { /* analytics must never break the app */ }
}
