// scripts/fetch-idle-timeout-smoke.ts — 判定 Bun 1.4.0 fetch 默认 socket 空闲超时(300s?)
// 是否会在「等响应头」阶段杀掉长思考型请求,以及 timeout:0 是否可靠禁用它。
//
// 方法(本地决定性,零外网/零 key):起一个 HTTP 服务器,把「发响应头」延迟 delayMs
// (模拟思考型模型首 token 前的沉默)。客户端裸 fetch,判定是 (a) 拿到响应 还是 (b)
// 在某阈值被 Bun 内部 TimeoutError 杀掉。对照组(裸 fetch)与 timeout:0 组「并行」打
// 同一服务器同延迟 —— 一次 delayMs 跑完两组,省一半时间且条件完全一致更严谨。
//
// 服务器显式 idleTimeout:0!Bun.serve 默认 10s 就放弃空闲请求(server-main.ts 里我们生产
// 服务器同样显式 idleTimeout:0),不设它服务器会先于客户端在 10s 关连接,测出的就是服务器
// idleTimeout 而非客户端 fetch 的 300s —— 首版 305s 实验正是这样作废的(ECONNRESET@12s)。
//
// 用法:
//   bun run scripts/fetch-idle-timeout-smoke.ts                 # 1s 对照(验证链路+timeout:0 键)
//   IDLE_PROBE_DELAY_MS=305000 bun run scripts/fetch-idle-timeout-smoke.ts   # 300s 真实判定
// 退出码:有 FAIL 则非零。
export {}; // module 标记:顶层 await 需要

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("  ok  " + name);
  else { failures++; console.error("FAIL  " + name + (detail !== undefined ? "  →  " + JSON.stringify(detail) : "")); }
}

const delayMs = Number(process.env.IDLE_PROBE_DELAY_MS ?? "1000");

const server = Bun.serve({
  port: 0,
  idleTimeout: 0, // 0 = 永不因空闲关闭请求(字节级,非秒);排除服务器端干扰
  async fetch() {
    await new Promise((r) => setTimeout(r, delayMs));
    return new Response("ok-after-delay", { status: 200 });
  },
});
const url = `http://127.0.0.1:${server.port}/slow`;

interface ProbeResult { label: string; ok: boolean; dt: number; err?: { name?: string; code?: string; message?: string } }
async function probe(label: string, init?: RequestInit & { timeout?: number | false }): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, init as RequestInit);
    const body = await res.text();
    const dt = Date.now() - t0;
    const ok = res.status === 200 && body === "ok-after-delay";
    return { label, ok, dt };
  } catch (err) {
    const dt = Date.now() - t0;
    const e = err as { name?: string; message?: string; code?: string };
    return { label, ok: false, dt, err: e };
  }
}

console.log(`[fetch-idle-timeout] Bun ${Bun.version}  delay=${delayMs}ms url=${url}`);
console.log(`并行发起 对照组(裸 fetch) + timeout:0 组,等 ${delayMs}ms…`);

// 并行:两组同时打同一延迟服务器,一次 delayMs 出两个结果。
const [control, disabled] = await Promise.all([
  probe("对照组(裸 fetch, 无 signal/timeout)"),
  probe("timeout:0 组", { timeout: 0 }),
]);

for (const r of [control, disabled]) {
  if (r.ok) check(`${r.label}: 拿到响应(${r.dt}ms, 撑过延迟)`, true);
  else {
    failures++;
    console.error(`  ✗ ${r.label}: 被杀(${r.dt}ms) name=${r.err?.name} code=${r.err?.code} msg=${r.err?.message}`);
  }
}

server.stop(true);

console.log("");
if (delayMs >= 300_000) {
  const killedAt = control.ok ? null : control.dt;
  console.log("=== 判定(客户端 socket 空闲超时) ===");
  if (control.ok && disabled.ok) {
    console.log(`裸 fetch 与 timeout:0 均撑过 ${delayMs}ms → 默认空闲超时 > ${delayMs}ms 或不存在,担忧不成立,无需改代码。`);
  } else if (!control.ok && disabled.ok) {
    console.log(`裸 fetch 在 ${killedAt}ms 被杀、timeout:0 撑过 ${delayMs}ms → 实锤:默认空闲超时 ≤ ${delayMs}ms 会杀长思考请求,且 timeout:0 可靠禁用 → 主链路 fetch 应加 timeout:0 治本。`);
  } else if (!control.ok && !disabled.ok) {
    console.log(`两组均被杀(对照组 ${control.dt}ms / timeout:0 ${disabled.dt}ms)→ timeout:0 未能禁用,需另找解法(如 BUN_CONFIG_HTTP_IDLE_TIMEOUT env)。`);
  } else {
    console.log(`裸 fetch 撑过但 timeout:0 被杀 —— 反常,需人工复核。`);
  }
} else {
  console.log("提示: 本档为短延迟对照(验证链路+timeout:0 键)。");
  console.log("      做 300s 真实判定: IDLE_PROBE_DELAY_MS=305000 bun run scripts/fetch-idle-timeout-smoke.ts");
}

process.exit(failures === 0 ? 0 : 1);
