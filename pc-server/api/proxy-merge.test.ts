// api/proxy-merge.test.ts — settings/proxy 是字段级合并:只提交 UA 不清空代理配置,只提交代理
// 字段不清空 UA;显式发空串才清空。代理页与「端口与请求」页靠这条契约各自保存互不覆盖。
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-proxy-merge-test-"));

import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function postProxy(body: unknown): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/proxy");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/proxy");
}

beforeEach(() => {
  setState({
    settings: {
      proxyConfig: {
        mode: "manual",
        url: "http://127.0.0.1:7890",
        username: "alice",
        password: "secret",
        bypassRules: "*.corp",
        userAgent: "Custom/1.0",
      },
    },
  } as unknown as State);
});

describe("settings/proxy 字段级合并", () => {
  test("只发 userAgent:代理字段保持", async () => {
    const res = await postProxy({ userAgent: "Other/2.0" });
    expect(res?.status).toBe(200);
    expect(state.settings.proxyConfig).toEqual({
      mode: "manual",
      url: "http://127.0.0.1:7890",
      username: "alice",
      password: "secret",
      bypassRules: "*.corp",
      userAgent: "Other/2.0",
    });
  });

  test("只发代理字段:userAgent 保持", async () => {
    await postProxy({ mode: "auto", url: "", username: "", password: "", bypassRules: "" });
    expect(state.settings.proxyConfig.mode).toBe("auto");
    expect(state.settings.proxyConfig.url).toBe("");
    expect(state.settings.proxyConfig.userAgent).toBe("Custom/1.0");
  });

  test("显式空串清空字段", async () => {
    await postProxy({ username: "" });
    expect(state.settings.proxyConfig.username).toBe("");
    expect(state.settings.proxyConfig.password).toBe("secret");
  });

  test("SOCKS 地址仍被拒绝且不改动状态", async () => {
    const res = await postProxy({ url: "socks5://127.0.0.1:1080" });
    expect(res?.status).toBe(400);
    expect(state.settings.proxyConfig.url).toBe("http://127.0.0.1:7890");
  });
});
