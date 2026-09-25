// foundation/origin-relay.ts — 界面 origin 接力:纯决策、白名单与页面构造(issue #62 换默认端口配套)
//
// 浏览器按 origin(协议+主机+端口)隔离 localStorage。桌面界面从旧 origin(如
// http://localhost:8080)挪到新 origin(http://localhost:17455)时,旧 origin 下的界面状态
// (标签/分栏布局、预绘制、代理测试地址、网页访问令牌)会整体"消失"。接力 = 升级后首次启动
// 在旧 origin 临时挂一张接力页(视觉即启动屏),读出白名单 localStorage 经服务端内存中转,
// 一次性凭证(nonce)交到新页面写回。任何一步失败都只退化成「界面状态重置一次」,绝不阻塞启动。
//
// 通用性:机制不绑定"换默认端口"这一次。设置里手动改端口、顺延后回归首选端口、将来换拨号
// 主机(localhost→127.0.0.1)都会触发同一条路径——旧 origin 有记录且与当前不同即接力。
//
// 纪律:本模块与 loopback.ts 一样是纯模块(零 I/O、零 Bun/node 引用)——web-ui 经 @server
// 引用白名单与查询键(先例见 tools/ask-user.ts),引入运行时依赖会炸浏览器打包。
// HTTP 面(临时监听、POST 校验、落地注入、记录文件读写)在 api/origin-relay.ts。

import { isLoopbackHostname } from "./loopback";
//
// 安全模型(威胁:外部网页伪造导入/外传数据):
//   - 数据只在回环上流转,经服务端内存中转,不落盘(ui-origin.json 只记 origin 字符串)、
//     不进 URL(nonce 是凭证不是数据)、不进日志;
//   - 只有拿到 nonce 的页面能导入,nonce 只写死在接力页 HTML 里(不读任何查询参数,杜绝
//     开放重定向),常量时间比较,一次性消费;
//   - 搬运键白名单单一来源(本模块),契约测试锁「键必须真实存在于 web-ui 源码、敏感键
//     (设置镜像,含 API Key)绝不入单」。

/** 落地 URL 上的接力凭证查询键;root.tsx 的导入脚本无论是否导入都剥掉它(刷新不重触发)。 */
export const RELAY_QUERY_KEY = "rikkahub-relay";

/** 落地页 <head> 里数据块的元素 id(root.tsx 导入脚本按 id 取块,取完即删)。 */
export const RELAY_SCRIPT_ID = "rikkahub-relay";

/** 接力页向临时监听提交数据的端点。命名带 __rikkahub 前缀,绝不与业务路由空间(/api)重叠。 */
export const RELAY_POST_PATH = "/__rikkahub/relay";

/**
 * 随界面 origin 搬运的 localStorage 键(单一来源,前端经 @server 引用同一份)。
 * 只收「换 origin 即丢且无法自动重建」的界面状态;缓存类(设置/列表/schema 镜像)自动重建
 * 不搬,敏感键(设置镜像含 API Key)绝不入单——契约测试锁定。
 */
export const ORIGIN_RELAY_KEYS: readonly string[] = [
  // 打开的标签页与分栏布局(用户摆出来的工作区,丢了最心疼)
  "rikkahub.container-tabs.v2",
  // 代理测试地址(纯 UI 偏好,设置页手填)
  "rikkahub:proxy-test-url",
  // 首帧预绘制:根字号/字体链效果器的最终值(不搬 = 首帧可能闪默认值)
  "rikkahub.prepaint.v1",
  // 首帧预绘制:明暗模式(不搬 = 暗色用户首启白闪一帧)
  "rikkahub.prepaint.theme.v1",
  // 网页访问令牌:本就由本服务签发,经本机回环中转不扩大暴露面;搬了设过密码的用户免重登
  "rikkahub:web-auth",
];

/** [LEGACY-MIGRATION: pre-v4-ui-origin]
 * 旧版(≤ v3)还把主题/语言存在 localStorage 的键族:theme-provider.tsx 的
 * storageKey="vite-ui-theme" 五键 + i18n.ts 的 "lang"。搬它们是为了让跨多版升级的老用户
 * 在新 origin 上照样跑完「主题/语言迁后端」的既有一次性迁移(那些迁移读的就是这些键)。
 * 拆除 = 删本数组(见 tmp_doc 方案 §13.11;到期条件:看板 v3 及更早版本日活 <1% 且
 * v4 发布满两版/约三个月)。 */
export const LEGACY_RELAY_KEYS: readonly string[] = [
  "vite-ui-theme",
  "vite-ui-theme-color",
  "vite-ui-theme-user-themes",
  "vite-ui-theme-custom-light",
  "vite-ui-theme-custom-dark",
  "lang",
];

/** 接力页实际读取(以及 POST 校验实际放行)的键全集。 */
export function allRelayKeys(): string[] {
  return [...ORIGIN_RELAY_KEYS, ...LEGACY_RELAY_KEYS];
}

/** [LEGACY-MIGRATION: pre-v4-ui-origin] ≤ 2.0.0-preview-v3 的默认端口,只用于下方
 *  旧版界面落脚点推断,不得挪作他用;随 inferPreV4UiOrigin 一并拆除。 */
export const LEGACY_DEFAULT_PORT = 8080;

// ─── 记录文件(ui-origin.json)的形状与校验;文件读写在 api/origin-relay.ts ───────

export interface UiOriginRecord {
  v: 1;
  origin: string;
  updatedAt: number;
}

/** 记录内容校验:不存在/损坏/字段非法一律按「无记录」处理(返回 null),绝不因记录坏而
 *  阻塞启动路径。v 留作未来格式演进钩子。 */
export function parseUiOriginRecord(raw: string | null): UiOriginRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1 || typeof rec.origin !== "string" || typeof rec.updatedAt !== "number") return null;
  try {
    new URL(rec.origin);
  } catch {
    return null;
  }
  return { v: 1, origin: rec.origin, updatedAt: rec.updatedAt };
}

export function serializeUiOriginRecord(origin: string, updatedAt: number): string {
  return JSON.stringify({ v: 1, origin, updatedAt });
}

// ─── 启动期决策(纯函数) ────────────────────────────────────────────────────────

export type OriginRelayPlan = { kind: "none" } | { kind: "relay"; fromOrigin: string };

/** 规范化为小写主机、无尾斜杠的 http origin 字符串;非 http / 不可解析 → null。
 *  我们自己写的记录恒为 `http://localhost:<port>`,规范化只是防御手改。 */
function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** [LEGACY-MIGRATION: pre-v4-ui-origin] 旧版(≤ v3)界面上次落脚点的推断:v3 及之前
 *  界面只拨 localhost,端口 = 用户手设值(state.json 的 settings.preferredPort)或旧默认
 *  8080。无记录但 state.json 已存在 → 老用户升级,推断旧 origin;全新安装(连 state 都
 *  没有)→ 没有旧 origin,不接力。拆除后:无记录 = 不接力,直接落记录。 */
export function inferPreV4UiOrigin(opts: { hadStateBeforeBoot: boolean; peekedPreferredPort: number | null }): string | null {
  if (!opts.hadStateBeforeBoot) return null;
  return `http://localhost:${opts.peekedPreferredPort ?? LEGACY_DEFAULT_PORT}`;
}

/** 启动期「要不要接力、从哪接力」的唯一裁决点。逐条规则(均有单测):
 *  1. 无界面消费者 / 非回环绑定 / 容器 → none(容器与无头服务的旧端口可能是 nginx 正指着的
 *     生产地址,挂临时监听只会添乱);
 *  2. 旧 origin = 记录值;无记录走旧版推断([LEGACY-MIGRATION]);全新安装 → none;
 *  3. 旧 origin 与当前相同 → none(绝大多数日常启动,零开销);
 *  4. 旧 origin 主机非回环 → none(防御:记录被手改成外部地址,绝不向外部地址挂监听);
 *  5. 其余 → relay。 */
export function planOriginRelay(opts: {
  recordedOrigin: string | null;
  currentOrigin: string;
  uiConsumer: boolean;
  loopbackIntent: boolean;
  inContainer: boolean;
  /** [LEGACY-MIGRATION: pre-v4-ui-origin] */
  hadStateBeforeBoot: boolean;
  /** [LEGACY-MIGRATION: pre-v4-ui-origin] */
  peekedPreferredPort: number | null;
}): OriginRelayPlan {
  const { recordedOrigin, currentOrigin, uiConsumer, loopbackIntent, inContainer } = opts;
  if (!uiConsumer || !loopbackIntent || inContainer) return { kind: "none" };
  // 记录在场但不可信(非 http / 不可解析)→ none:记录是权威,「值坏」与「没有记录」
  // 不是一回事,不去猜(只有确无记录才走旧版推断)。
  const fromOrigin = recordedOrigin !== null
    ? normalizeHttpOrigin(recordedOrigin)
    : inferPreV4UiOrigin(opts);
  if (fromOrigin === null) return { kind: "none" };
  if (fromOrigin === normalizeHttpOrigin(currentOrigin)) return { kind: "none" };
  if (!isLoopbackHostname(new URL(fromOrigin).hostname)) return { kind: "none" };
  return { kind: "relay", fromOrigin };
}

// ─── 页面构造(纯字符串;值一律经 JSON.stringify 嵌入,防拼接注入) ───────────────

/** 接力页内联脚本:读白名单 localStorage → POST 给本临时监听(成功即带 nonce 跳新 origin,
 *  任何失败/1.5s 超时都直达新 origin 不带凭证——落地兜底永远存在,绝不卡死在旧 origin)。
 *  to 含原路径与查询,落地后用户停在原地而不是被扔回根路径。 */
export function buildRelayPageScript(opts: { to: string; nonce: string; keys: readonly string[] }): string {
  const to = JSON.stringify(opts.to);
  const nonce = JSON.stringify(opts.nonce);
  const keys = JSON.stringify(opts.keys);
  return `(function(){window.__RIKKAHUB_RELAY__=1;var to=${to},n=${nonce},keys=${keys};try{var e={};for(var i=0;i<keys.length;i++){var v=localStorage.getItem(keys[i]);if(v!==null)e[keys[i]]=v}}catch(x){}var go=function(ok){location.replace(to+(ok?(to.indexOf("?")<0?"?":"&")+"${RELAY_QUERY_KEY}="+n:""))};var t=setTimeout(function(){go(false)},1500);fetch("${RELAY_POST_PATH}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({n:n,entries:e})}).then(function(r){clearTimeout(t);go(r.ok)},function(){clearTimeout(t);go(false)})})();`;
}

/** 落地页数据块:非可执行 JSON(type="application/json"),不受 CSP script-src 影响;
 *  `<` 转义成 < 防 `</script>` 截断数据块。root.tsx 的导入脚本按 id 取块写回后删除。 */
export function buildLandingInjection(entries: Record<string, string>): string {
  const json = JSON.stringify(entries).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${RELAY_SCRIPT_ID}">${json}</script>`;
}

/** POST entries 的白名单过滤:键必须在 allowedKeys、值必须是字符串;其余(含 __proto__ 等
 *  危险键)静默丢弃。接力页本就只读白名单,这里再滤一遍是纵深防御(伪造 POST 也带不进私货)。 */
export function filterRelayEntries(value: unknown, allowedKeys: readonly string[]): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const allowed = new Set(allowedKeys);
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (allowed.has(key) && typeof val === "string") out[key] = val;
  }
  return out;
}
