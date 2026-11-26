// 代理地址的解析、「不走代理」名单的判定、引擎宿主把生效代理镜像进环境变量(foundation/net.ts)。不联网。
import http from "node:http";
import https from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearAppErrors, recentAppErrors } from "../observability/app-errors";
import { composeProxyUrl, resetProxyEnvMirrorForTests, resolveEffectiveProxy, shouldBypassProxy, syncProxyEnvToProcess } from "./net";
import type { ProxyConfig } from "./types";

const manual = (url: string, extra: Partial<ProxyConfig> = {}): ProxyConfig =>
  ({ mode: "manual", url, username: "", password: "", bypassRules: "", userAgent: "", ...extra }) as ProxyConfig;

describe("composeProxyUrl:设置页只填「主机:端口」也要带上协议", () => {
  test("无凭证、无协议 → 补 http://", () => {
    expect(composeProxyUrl("127.0.0.1:7890", "", "")).toBe("http://127.0.0.1:7890");
    expect(composeProxyUrl("  proxy.corp:3128  ", "", "")).toBe("http://proxy.corp:3128");
    expect(composeProxyUrl("[::1]:7890", "", "")).toBe("http://[::1]:7890");
  });
  test("已带协议的原样保留(大小写不敏感,https 不改成 http)", () => {
    expect(composeProxyUrl("http://127.0.0.1:7890", "", "")).toBe("http://127.0.0.1:7890");
    expect(composeProxyUrl("HTTP://127.0.0.1:7890", "", "")).toBe("HTTP://127.0.0.1:7890");
    expect(composeProxyUrl("https://proxy.corp:443", "", "")).toBe("https://proxy.corp:443");
  });
  test("带凭证:无协议也补 http://,凭证按 WHATWG 编码一次", () => {
    expect(composeProxyUrl("127.0.0.1:7890", "u", "p")).toBe("http://u:p@127.0.0.1:7890/");
    expect(composeProxyUrl("https://h:1", "user@example.com", "p@ss")).toBe("https://user%40example.com:p%40ss@h:1/");
  });
  test("空串 → 空串", () => {
    expect(composeProxyUrl("   ", "u", "p")).toBe("");
  });
  test("resolveEffectiveProxy 的手动地址带协议(fetch 壳与环境变量拿到的都是它)", () => {
    expect(resolveEffectiveProxy(manual("127.0.0.1:7890"))).toEqual({ url: "http://127.0.0.1:7890", source: "manual" });
    expect(resolveEffectiveProxy(manual(""))).toEqual({ url: undefined, source: "none" });
  });
});

describe("shouldBypassProxy", () => {
  test("写死的回环三项都豁免,包括 IPv6 的 ::1", () => {
    expect(shouldBypassProxy("http://localhost:9/", "")).toBe(true);
    expect(shouldBypassProxy("http://127.0.0.1:9/", "")).toBe(true);
    expect(shouldBypassProxy("http://[::1]:9/", "")).toBe(true);
    expect(shouldBypassProxy("https://[::1]/", "")).toBe(true);
  });
  test("用户名单里的 IPv6 字面量:裸写不按端口拆,方括号形式可带端口", () => {
    expect(shouldBypassProxy("http://[fd00::5]:8080/", "fd00::5")).toBe(true);
    expect(shouldBypassProxy("http://[fd00::5]:8080/", "[fd00::5]:8080")).toBe(true);
    expect(shouldBypassProxy("http://[fd00::5]:9/", "[fd00::5]:8080")).toBe(false);
    expect(shouldBypassProxy("http://[fd00::5]:9/", "[fd00::5]")).toBe(true);
    expect(shouldBypassProxy("http://[fd00::6]:9/", "fd00::5")).toBe(false);
  });
  test("host:port 限定端口:端口不符不豁免", () => {
    expect(shouldBypassProxy("http://probe.invalid:81/", "probe.invalid:81")).toBe(true);
    expect(shouldBypassProxy("http://probe.invalid:82/", "probe.invalid:81")).toBe(false);
    expect(shouldBypassProxy("http://probe.invalid/", "probe.invalid:80")).toBe(true);
    expect(shouldBypassProxy("https://probe.invalid/", "probe.invalid:80")).toBe(false);
  });
  test("域名、通配、CIDR、全豁免,逗号与空白都可分隔", () => {
    expect(shouldBypassProxy("https://example.com/", "example.com")).toBe(true);
    expect(shouldBypassProxy("https://a.example.com/", "example.com")).toBe(false);
    expect(shouldBypassProxy("https://a.example.com/", "*.example.com")).toBe(true);
    expect(shouldBypassProxy("https://example.com/", "*.example.com")).toBe(true);
    expect(shouldBypassProxy("https://a.example.com/", ".example.com")).toBe(true);
    expect(shouldBypassProxy("http://10.1.2.3/", "10.0.0.0/8")).toBe(true);
    expect(shouldBypassProxy("http://11.1.2.3/", "10.0.0.0/8")).toBe(false);
    expect(shouldBypassProxy("https://any.where/", "*")).toBe(true);
    expect(shouldBypassProxy("https://b.corp/", "a.corp b.corp,c.corp")).toBe(true);
    expect(shouldBypassProxy("https://api.openai.com/", "a.corp b.corp")).toBe(false);
  });
  test("解析不出的地址不豁免", () => {
    expect(shouldBypassProxy("not a url", "*")).toBe(false);
  });
});

describe("syncProxyEnvToProcess:引擎宿主把生效代理镜像进环境变量", () => {
  const KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const proxyEnv = () => Object.fromEntries(KEYS.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
  // Windows 的环境变量不分大小写:写 HTTPS_PROXY 后 https_proxy 也读得到
  const asSeen = (expected: Record<string, string>) =>
    process.platform === "win32"
      ? Object.fromEntries(Object.entries(expected).flatMap(([key, value]) => [[key, value], [key.toLowerCase(), value]]))
      : expected;
  const clearKeys = () => {
    for (const key of KEYS) delete process.env[key];
  };
  const direct = { mode: "direct", url: "", username: "", password: "", bypassRules: "", userAgent: "" } as ProxyConfig;

  beforeEach(() => {
    resetProxyEnvMirrorForTests();
    clearKeys();
    clearAppErrors();
  });
  afterEach(() => {
    resetProxyEnvMirrorForTests();
    clearKeys();
  });
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("手动代理:四个代理变量写同一地址,NO_PROXY 是回环三项 + 用户名单(只用逗号),不留 ALL_PROXY", () => {
    expect(syncProxyEnvToProcess(manual("127.0.0.1:7890", { username: "u", password: "p@ss", bypassRules: "a.corp  b.corp,\n10.0.0.0/8" })))
      .toBe("http://u:p%40ss@127.0.0.1:7890/");
    const url = "http://u:p%40ss@127.0.0.1:7890/";
    const noProxy = "localhost,127.0.0.1,::1,a.corp,b.corp,10.0.0.0/8";
    expect(proxyEnv()).toEqual({ HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy });
  });

  test("切到直连或手动地址留空:先写过的全部清掉", () => {
    syncProxyEnvToProcess(manual("http://127.0.0.1:7890"));
    expect(syncProxyEnvToProcess(direct)).toBeUndefined();
    expect(proxyEnv()).toEqual({});
    syncProxyEnvToProcess(manual("http://127.0.0.1:7890"));
    expect(syncProxyEnvToProcess(manual(""))).toBeUndefined();
    expect(proxyEnv()).toEqual({});
  });

  test("同值连调幂等,换值覆盖", () => {
    syncProxyEnvToProcess(manual("http://127.0.0.1:7890"));
    const first = proxyEnv();
    syncProxyEnvToProcess(manual("http://127.0.0.1:7890"));
    expect(proxyEnv()).toEqual(first);
    syncProxyEnvToProcess(manual("http://127.0.0.1:7891"));
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7891");
    expect(process.env.http_proxy).toBe("http://127.0.0.1:7891");
  });

  test("env 模式(容器)不写;镜像前原有的变量是事实源,manual 覆盖后切回 env 恢复原值", () => {
    process.env.HTTPS_PROXY = "http://docker-proxy:3128";
    process.env.NO_PROXY = "internal.svc";
    const env = { ...direct, mode: "env" } as ProxyConfig;
    expect(syncProxyEnvToProcess(env)).toBeUndefined();
    expect(proxyEnv()).toEqual(asSeen({ HTTPS_PROXY: "http://docker-proxy:3128", NO_PROXY: "internal.svc" }));
    syncProxyEnvToProcess(manual("http://127.0.0.1:7890"));
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(syncProxyEnvToProcess(env)).toBeUndefined();
    expect(proxyEnv()).toEqual(asSeen({ HTTPS_PROXY: "http://docker-proxy:3128", NO_PROXY: "internal.svc" }));
    // 容器里切「强制直连」:docker 注入的也清掉,子进程与 pi 的 WebSocket 才是真直连;再切回 env 仍能恢复
    syncProxyEnvToProcess(direct);
    expect(proxyEnv()).toEqual({});
    syncProxyEnvToProcess(env);
    expect(proxyEnv()).toEqual(asSeen({ HTTPS_PROXY: "http://docker-proxy:3128", NO_PROXY: "internal.svc" }));
  });

  test("env 模式:环境里有代理变量时 node:http / node:https 也换上按它走的 Agent,没有就不换", () => {
    const httpAgent = http.globalAgent;
    const httpsAgent = https.globalAgent;
    const env = { ...direct, mode: "env" } as ProxyConfig;
    syncProxyEnvToProcess(env);
    expect(http.globalAgent).toBe(httpAgent);
    expect(https.globalAgent).toBe(httpsAgent);
    resetProxyEnvMirrorForTests();
    process.env.HTTPS_PROXY = "http://docker-proxy:3128";
    syncProxyEnvToProcess(env);
    expect(https.globalAgent).not.toBe(httpsAgent);
    syncProxyEnvToProcess(direct);
    expect(https.globalAgent).toBe(httpsAgent);
  });

  test("node:http / node:https 的全局 Agent:有代理时两个都换,清空后还原成原来的", () => {
    const httpAgent = http.globalAgent;
    const httpsAgent = https.globalAgent;
    syncProxyEnvToProcess(manual("http://127.0.0.1:7890"));
    expect(http.globalAgent).not.toBe(httpAgent);
    expect(https.globalAgent).not.toBe(httpsAgent);
    syncProxyEnvToProcess(manual("http://127.0.0.1:7891"));
    expect(http.globalAgent).not.toBe(httpAgent);
    syncProxyEnvToProcess(direct);
    expect(http.globalAgent).toBe(httpAgent);
    expect(https.globalAgent).toBe(httpsAgent);
  });

  test("node:http 不接受的地址:不抛,环境变量照写,错误中心记一条 warn", () => {
    const httpAgent = http.globalAgent;
    expect(syncProxyEnvToProcess(manual("http://127.0.0.1:99999"))).toBe("http://127.0.0.1:99999");
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:99999");
    expect(http.globalAgent).toBe(httpAgent);
    expect(recentAppErrors().filter((entry) => entry.domain === "network" && entry.severity === "warn").length).toBe(1);
  });
});
