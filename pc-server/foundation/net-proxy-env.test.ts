// 代理地址的解析与「不走代理」名单的判定(foundation/net.ts),纯函数,不联网。
import { describe, expect, test } from "bun:test";

import { composeProxyUrl, resolveEffectiveProxy, shouldBypassProxy } from "./net";
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
