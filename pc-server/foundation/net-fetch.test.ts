// 6-2 回归:统一出站 fetch 包装(默认超时/调用方 signal 并联)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  fetchWithTimeout,
  getDefaultUserAgent,
  installProxyFetchInterceptor,
  normalizeProxyConfig,
  resolveUserAgent,
} from "./net";
import { APP_VERSION } from "../updates/index";
import type { ProxyConfig } from "./types";

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fast") return new Response("ok");
      // /echo-encoding:回显收到的 accept-encoding(SSE 禁压缩拦截器断言用)
      if (url.pathname === "/echo-encoding") {
        return new Response(request.headers.get("accept-encoding") ?? "none");
      }
      // /echo-ua:回显收到的 user-agent(UA 注入拦截器断言用)
      if (url.pathname === "/echo-ua") {
        return new Response(request.headers.get("user-agent") ?? "none");
      }
      // /slow:挂住直到客户端中止(模拟黑洞上游)
      await new Promise(() => { /* 永不 resolve,连接由 abort 撕掉 */ });
      return new Response("unreachable");
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("fetchWithTimeout(6-2)", () => {
  test("正常响应原样返回", async () => {
    const res = await fetchWithTimeout(`${base}/fast`);
    expect(await res.text()).toBe("ok");
  });

  test("上游黑洞 → 按 timeoutMs 中止而非永挂", async () => {
    const t0 = Date.now();
    expect(fetchWithTimeout(`${base}/slow`, { timeoutMs: 300 })).rejects.toThrow();
    await Bun.sleep(50);
    // 若未生效,本用例会撞 bun test 的 5s 超时;到这里说明按时中止
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("调用方 signal 先触发 → 立即中止(生成中止透传)", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(`${base}/slow`, { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort(new Error("user aborted"));
    expect(pending).rejects.toThrow();
  });

  test("默认超时为 30s", () => {
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(30_000);
  });
});

// 内测反馈(Kimi 流式"停住→哗啦一大段")修复回归:SSE 若被上游/中间层压缩,解压端按
// 压缩块攒明文,逐事件 flush 失效。拦截器对 Accept: text/event-stream 的请求统一注入
// accept-encoding: identity(收口哲学同 timeout:0——凡走 globalThis.fetch 的流式请求
// 自动免疫,pi 引擎在内,新引擎零负担)。
describe("fetch 拦截器:SSE 请求禁用压缩协商", () => {
  test("SSE 注入 identity;非 SSE 不注入;显式传值尊重", async () => {
    const originalFetch = globalThis.fetch;
    try {
      installProxyFetchInterceptor(() => ({ mode: "direct" } as ProxyConfig));
      // SSE 请求 → 注入 identity
      const sse = await fetch(`${base}/echo-encoding`, {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: "{}",
      });
      expect(await sse.text()).toBe("identity");
      // 非 SSE → 不注入(维持 Bun 默认协商,值随运行时,只断言不是 identity)
      const plain = await fetch(`${base}/echo-encoding`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(await plain.text()).not.toBe("identity");
      // 调用方显式传 accept-encoding → 尊重不覆盖
      const explicit = await fetch(`${base}/echo-encoding`, {
        method: "POST",
        headers: { Accept: "text/event-stream", "accept-encoding": "gzip" },
        body: "{}",
      });
      expect(await explicit.text()).toBe("gzip");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// 台账 §7.3:品牌/自定义 User-Agent 经 fetch 拦截器统一注入(收口哲学同 timeout:0——凡走
// globalThis.fetch 的出站请求自动免疫,聊天/pi/搜索/MCP/未来引擎零负担)。行为锁:
// 注入默认品牌 UA、自定义 UA 生效、请求已带 UA 不覆盖(??= 语义对齐安卓)。
describe("fetch 拦截器:User-Agent 注入(§7.3)", () => {
  const install = (cfg: ProxyConfig) => installProxyFetchInterceptor(() => cfg);

  test("品牌默认 UA = RikkaHub-Desktop/<APP_VERSION>", () => {
    const DEFAULT_USER_AGENT = getDefaultUserAgent();
    expect(DEFAULT_USER_AGENT).toBe(`RikkaHub-Desktop/${APP_VERSION}`);
    expect(resolveUserAgent(undefined)).toBe(DEFAULT_USER_AGENT);
    expect(resolveUserAgent({ userAgent: "" } as ProxyConfig)).toBe(DEFAULT_USER_AGENT);
    expect(resolveUserAgent({ userAgent: "  " } as ProxyConfig)).toBe(DEFAULT_USER_AGENT);
    expect(resolveUserAgent({ userAgent: "MyClient/1.0" } as ProxyConfig)).toBe("MyClient/1.0");
  });

  test("未配自定义 UA → 注入品牌默认;配置 → 注入自定义", async () => {
    const originalFetch = globalThis.fetch;
    try {
      install({ mode: "direct", userAgent: "" } as ProxyConfig);
      expect(await (await fetch(`${base}/echo-ua`)).text()).toBe(getDefaultUserAgent());

      install({ mode: "direct", userAgent: "MyCorpGateway/2.1" } as ProxyConfig);
      expect(await (await fetch(`${base}/echo-ua`)).text()).toBe("MyCorpGateway/2.1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("请求已显式带 UA → 尊重不覆盖(对齐安卓)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      install({ mode: "direct", userAgent: "MyCorpGateway/2.1" } as ProxyConfig);
      const res = await fetch(`${base}/echo-ua`, { headers: { "User-Agent": "RikkaHub-PC" } });
      expect(await res.text()).toBe("RikkaHub-PC");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("normalizeProxyConfig: userAgent 归一化", () => {
  test("缺省/非法 → 空串;有效值保留(去空白);往返不丢", () => {
    expect(normalizeProxyConfig(undefined).userAgent).toBe("");
    expect(normalizeProxyConfig({}).userAgent).toBe("");
    expect(normalizeProxyConfig({ userAgent: 123 }).userAgent).toBe("123");
    expect(normalizeProxyConfig({ userAgent: "  MyUA/1.0  " }).userAgent).toBe("MyUA/1.0");
    // 往返:配置里的自定义 UA 经 normalize 不丢(跨重启持久化的前提)。
    const roundTrip = normalizeProxyConfig(normalizeProxyConfig({ mode: "manual", url: "127.0.0.1:7890", userAgent: "UA/9" }));
    expect(roundTrip.userAgent).toBe("UA/9");
  });
});
