// api/origin-relay.ts — 界面 origin 接力的 HTTP 面:记录读写、旧 origin 临时监听、接力页、
// POST 校验、落地注入(foundation/origin-relay.ts 是纯决策与白名单,见其头注)。
//
// 生命周期:启动期 planOriginRelay 判定要接力 → startSession 在旧 origin(回环整组,单次
// 尝试不顺延——顺延没意义,旧端口被别人占着就说明旧 origin 已经不归我们)挂临时监听 →
// 界面消费者先访问接力页 → 页面读白名单 localStorage POST 上来(Origin + 一次性 nonce 双闸,
// 只收一次)→ 页面带 nonce 跳新 origin → 主监听的落地判定注入数据块、写记录、1s 后关临时
// 监听。落地判定是「终局」:无论带没带凭证,桌面 origin 上出现 document 落地即写记录并结束
// 会话——界面一旦在新 origin 开始写状态,旧 origin 的数据就过期了,绝不能下次启动再搬来覆盖。
// 未落地时进程退出/10 分钟上限只关监听不写记录,下次启动重试(此时新 origin 尚无状态,重试
// 无风险)。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { reportError } from "../observability/app-errors";
import {
  RELAY_POST_PATH,
  RELAY_QUERY_KEY,
  allRelayKeys,
  buildLandingInjection,
  buildRelayPageScript,
  filterRelayEntries,
  parseUiOriginRecord,
  serializeUiOriginRecord,
} from "../foundation/origin-relay";
import { bindFirstUsable, resolveListenHostnames, stopListeners, type StoppableListener } from "../foundation/port-binding";
import { HTML_CSP, resolveStaticRoot } from "./static";

/** POST body 上限:白名单键的理论最大值远小于此,超限(413)会让页面走 go(false) 直达
 *  新 origin——这正是设计好的退化路径。 */
const RELAY_MAX_BODY_BYTES = 1024 * 1024;

/** 落地后延迟关闭临时监听:给在途 POST/页面收尾留 1s,也让「落地即终局」先被观察到。 */
const RELAY_CLOSE_AFTER_LANDING_MS = 1000;

/** 临时监听的安全上限:便携模式浏览器冷启动可能慢,但不该为一次迁移永久占着旧端口。
 *  到点未落地 → 关闭且不写记录,下次启动重试。 */
const RELAY_SESSION_CAP_MS = 10 * 60_000;

/** splash.html 读不到时的接力页底版:与启动屏同底色(浅 oklch(.992 .002 240)/暗
 *  oklch(.12 .006 240)),极简。正常发布产物必有 splash.html,这只是兜底。 */
const FALLBACK_RELAY_PAGE_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>RikkaHub</title><style>html,body{margin:0;height:100%;background:oklch(.992 .002 240)}' +
  '@media (prefers-color-scheme:dark){html,body{background:oklch(.12 .006 240)}}</style></head><body></body></html>';

// ─── 记录文件(dataDir/ui-origin.json,原子写,不进任何备份) ────────────────────

export function readUiOriginRecord(recordPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(recordPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    // 权限/占用等读失败按无记录处理:接力最坏不做,界面状态重置一次,不能阻塞启动。
    reportError("internal", "info", "ui-origin.json 读取失败,按无记录处理", err, "ui_origin_record_unreadable");
    return null;
  }
  const record = parseUiOriginRecord(raw);
  if (!record && raw.trim().length > 0) {
    reportError("internal", "info", "ui-origin.json 内容非法,按无记录处理(下次落地会重写)", undefined, "ui_origin_record_corrupt");
  }
  return record?.origin ?? null;
}

export function writeUiOriginRecord(recordPath: string, origin: string): void {
  try {
    mkdirSync(dirname(recordPath), { recursive: true });
    const tempPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, serializeUiOriginRecord(origin, Date.now()));
    renameSync(tempPath, recordPath);
  } catch (err) {
    // 写失败只影响「下次 origin 变化时接力可能不做」,数据本体不丢——info 级留痕即可。
    reportError("internal", "info", "ui-origin.json 写入失败", err, "ui_origin_record_write_failed");
  }
}

// ─── 会话与协调器 ───────────────────────────────────────────────────────────────

export interface RelaySession {
  readonly fromOrigin: string;
  /** 界面消费者的首跳地址:旧 origin 上的接力页(根路径)。 */
  readonly entryUrl: string;
  /** 立即关闭临时监听(不写记录——没落地就不算搬家完成)。 */
  stop(): void;
}

export interface OriginRelayApi {
  /** 在旧 origin 上开临时监听。旧端口不可用(被占/保留段)→ 返回 null:放弃接力,
   *  调用方记一行日志即可,启动绝不受影响。 */
  startSession(fromOrigin: string): RelaySession | null;
  /** 主监听 fetch 在 routeStatic 前对静态分支调用。桌面 origin 的 document 落地:写记录;
   *  活跃会话存在且查询凭证匹配待取数据时,返回注入进 index.html <head> 的数据块。
   *  这是接力的唯一落地判定点(Host 必须是桌面 origin——局域网 IP/域名访问不算)。 */
  noteDocumentLanding(request: Request, url: URL): string | undefined;
  /** 停服时关闭一切临时监听(不写记录)。 */
  stopAll(): void;
}

interface RelaySessionState {
  fromOrigin: string;
  nonce: string;
  listeners: StoppableListener[];
  /** 接力页 POST 上来的白名单数据;null = 尚未收到。 */
  payload: Record<string, string> | null;
  received: boolean;
  stopped: boolean;
  capTimer: ReturnType<typeof setTimeout> | null;
  landingCloseTimer: ReturnType<typeof setTimeout> | null;
}

interface RelayRuntime {
  state: RelaySessionState;
  keys: string[];
  toOrigin: string;
  splashHtml: string | null;
  landingCloseTimer: ReturnType<typeof setTimeout> | null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // 长度分支不常量时间,但只泄露长度——nonce 本体比较仍常量时间。
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readSplashHtml(): string | null {
  const root = resolveStaticRoot();
  if (!root) return null;
  try {
    return readFileSync(join(root, "splash.html"), "utf8");
  } catch {
    // 静态根存在但 splash 缺失(异常产物布局):退同底色极简页,接力流程照走。
    return null;
  }
}

function injectAfterHeadOpen(html: string, snippet: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (headOpen) => headOpen + snippet);
  // 底版意外没有 <head>(理论不可能):换成我们自己的兜底页,保证脚本一定在。
  return FALLBACK_RELAY_PAGE_HTML.replace("</head>", `${snippet}</head>`);
}

function handleRelayRequest(rt: RelayRuntime, request: Request): Response | Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === RELAY_POST_PATH) {
      return handleRelayPost(rt, request);
    }
    const dest = request.headers.get("sec-fetch-dest");
    if (request.method === "GET" && (dest === null || dest === "document")) {
      return relayPageResponse(rt, url);
    }
    return new Response("Not Found", { status: 404 });
  } catch (err) {
    // 临时监听只服务接力:这里任何异常都兜 500,页面端 1.5s 超时会直达新 origin。
    reportError("internal", "warn", "origin 接力临时监听处理异常", err, "origin_relay_handler_error");
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function handleRelayPost(rt: RelayRuntime, request: Request): Promise<Response> {
  const { state } = rt;
  // 双闸之一:Origin 必须等于旧 origin。Chromium 对 POST(含同源 fetch)恒发 Origin;
  // 缺失即拒绝——外部网页伪造不了这个头下的合法值。
  const origin = request.headers.get("origin");
  if (!origin || origin.trim().toLowerCase() !== state.fromOrigin.toLowerCase()) {
    return new Response("Forbidden", { status: 403 });
  }
  // 只收一次:多窗口/重放不给第二次覆盖机会。
  if (state.received) return new Response("Gone", { status: 410 });
  let body: unknown;
  try {
    body = JSON.parse((await request.text()) || "null");
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const rec = (body ?? {}) as { n?: unknown; entries?: unknown };
  // 双闸之二:一次性 nonce,常量时间比较。nonce 只写死在接力页 HTML 里,外部拿不到。
  if (typeof rec.n !== "string" || !constantTimeEquals(rec.n, state.nonce)) {
    return new Response("Forbidden", { status: 403 });
  }
  state.payload = filterRelayEntries(rec.entries, rt.keys);
  state.received = true;
  return new Response(null, { status: 204 });
}

function relayPageResponse(rt: RelayRuntime, url: URL): Response {
  // 目标地址服务端写死(不读任何查询参数,杜绝把接力页当开放重定向跳板);保留原路径与
  // 查询,落地后用户停在原地。
  const to = `${rt.toOrigin}${url.pathname}${url.search}`;
  const script = buildRelayPageScript({ to, nonce: rt.state.nonce, keys: rt.keys });
  const html = injectAfterHeadOpen(rt.splashHtml ?? FALLBACK_RELAY_PAGE_HTML, `<script>${script}</script>`);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": HTML_CSP,
    },
  });
}

function stopRelayRuntime(rt: RelayRuntime): void {
  const { state } = rt;
  if (state.stopped) return;
  state.stopped = true;
  if (state.capTimer) clearTimeout(state.capTimer);
  if (state.landingCloseTimer) clearTimeout(state.landingCloseTimer);
  stopListeners(state.listeners);
}

export function createOriginRelayApi(opts: {
  recordPath: string;
  currentOrigin: string;
  /** 已读出的记录值(避免与 planOriginRelay 各读一次文件);null = 无记录。 */
  recordedOrigin?: string | null;
  /** 测试注入:固定 nonce。 */
  randomNonce?: () => string;
}): OriginRelayApi {
  const { recordPath, currentOrigin } = opts;
  const makeNonce = opts.randomNonce ?? (() => randomBytes(16).toString("base64url"));
  // 桌面 origin 的 Host 形态(如 "localhost:17455"),落地判定只认它。
  let desktopHost = "";
  try {
    desktopHost = new URL(currentOrigin).host.toLowerCase();
  } catch {
    // currentOrigin 由 server.ts 用 uiOrigin(port) 拼出,恒可解析;防御分支,不触发。
  }
  let lastRecordedOrigin = opts.recordedOrigin ?? null;
  let runtime: RelayRuntime | null = null;

  const persistRecord = (): void => {
    if (lastRecordedOrigin === currentOrigin) return;
    lastRecordedOrigin = currentOrigin;
    writeUiOriginRecord(recordPath, currentOrigin);
  };

  return {
    startSession(fromOrigin: string): RelaySession | null {
      if (runtime && !runtime.state.stopped) stopRelayRuntime(runtime);
      let fromUrl: URL;
      try {
        fromUrl = new URL(fromOrigin);
      } catch {
        return null;
      }
      const port = Number(fromUrl.port);
      if (!(port > 0 && port <= 65535)) return null;
      const state: RelaySessionState = {
        fromOrigin,
        nonce: makeNonce(),
        listeners: [],
        payload: null,
        received: false,
        stopped: false,
        capTimer: null,
        landingCloseTimer: null,
      };
      const rt: RelayRuntime = {
        state,
        keys: allRelayKeys(),
        toOrigin: currentOrigin,
        splashHtml: readSplashHtml(),
        landingCloseTimer: null,
      };
      // 单次尝试、不顺延、不 OS 兜底:旧端口被占 = 旧 origin 已不归我们,接力放弃。
      // localhost 同样整组占 127.0.0.1+::1(只占一半会重演 #62:WebView 先敲 ::1)。
      const bound = bindFirstUsable(
        [{ port, hostnames: resolveListenHostnames(fromUrl.hostname) }],
        (hostname, listenPort) =>
          Bun.serve({
            hostname,
            port: listenPort,
            idleTimeout: 0,
            maxRequestBodySize: RELAY_MAX_BODY_BYTES,
            fetch: (request) => handleRelayRequest(rt, request),
          }),
      );
      if (!bound.ok) return null;
      state.listeners = bound.listeners;
      state.capTimer = setTimeout(() => stopRelayRuntime(rt), RELAY_SESSION_CAP_MS);
      state.capTimer.unref?.();
      runtime = rt;
      return {
        fromOrigin,
        entryUrl: `${fromOrigin}/`,
        stop: () => stopRelayRuntime(rt),
      };
    },

    noteDocumentLanding(request: Request, url: URL): string | undefined {
      if (request.headers.get("sec-fetch-dest") !== "document") return undefined;
      const host = request.headers.get("host")?.trim().toLowerCase();
      if (host !== desktopHost) return undefined;
      // 桌面 origin 落地:无论有没有接力会话,先记录「界面现在待在这里」。
      persistRecord();
      const rt = runtime;
      if (!rt) return undefined;
      const provided = url.searchParams.get(RELAY_QUERY_KEY);
      const payload = rt.state.payload;
      const matched = payload !== null && provided !== null && constantTimeEquals(provided, rt.state.nonce);
      // 落地即终局:无论凭证匹配与否,会话结束、临时监听延迟关闭(不匹配 = 接力被放弃,
      // 待取数据就地丢弃——界面已在新 origin 活动,旧数据过期,绝不能再搬)。
      if (!rt.state.stopped && !rt.landingCloseTimer) {
        rt.landingCloseTimer = setTimeout(() => stopRelayRuntime(rt), RELAY_CLOSE_AFTER_LANDING_MS);
        rt.landingCloseTimer.unref?.();
      }
      rt.state.payload = null;
      if (!matched || payload === null) return undefined;
      return buildLandingInjection(payload);
    },

    stopAll(): void {
      if (runtime) stopRelayRuntime(runtime);
    },
  };
}
