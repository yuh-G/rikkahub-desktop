// api/settings-provider-oauth.test.ts — 订阅供应商 POST 保存的 authMode 保护锁。
// 关键不变量(方案 §3):
//   1. 已登录的订阅供应商(authMode=oauth):前端 draft 的滞后 authMode 不得覆盖服务端真值;
//   2. 未登录的订阅供应商(authMode=oauth):服务端真值同样优先,前端误传 apiKey 不得改形态;
//   3. apiKey 供应商:authMode 正常跟随 body(用户可切形态)。

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-provider-oauth-test-"));

import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

const KIMI_ID = "f9622c8b-5037-4540-b875-3d301521367b";

async function postProvider(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/provider");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/provider");
}

async function postRestore(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/provider/oauth/restore");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/provider/oauth/restore");
}

function seedProvider(overrides: Record<string, unknown>): void {
  setState({
    settings: {
      dismissedProviderIds: [],
      providers: [
        {
          id: KIMI_ID,
          type: "claude",
          enabled: true,
          name: "Kimi Code",
          baseUrl: "https://api.kimi.com/coding",
          authMode: "oauth",
          oauth: { flow: "kimi-coding", credential: { type: "oauth", access: "a", refresh: "r", expires: 1 }, signedInAt: 1 },
          models: [],
          balanceOption: { enabled: false, apiPath: "", resultPath: "" },
          ...overrides,
        },
      ],
    },
  } as unknown as State);
}

describe("settings/provider POST:订阅供应商 authMode 保护", () => {
  beforeEach(() => seedProvider({}));

  test("已登录订阅供应商:前端滞后 authMode=apiKey 不得覆盖服务端 oauth", async () => {
    const res = await postProvider({ id: KIMI_ID, name: "Kimi Code", authMode: "apiKey" });
    expect(res?.status).toBe(200);
    const p = state.settings.providers.find((x) => x.id === KIMI_ID);
    // 服务端真值(oauth)优先,前端滞后值被丢弃
    expect(p?.authMode).toBe("oauth");
    expect(p?.oauth?.credential?.refresh).toBe("r");
  });

  test("未登录订阅供应商(无 oauth 行):authMode=oauth 同样优先", async () => {
    seedProvider({ oauth: undefined });
    const res = await postProvider({ id: KIMI_ID, name: "Kimi Code", authMode: "apiKey" });
    expect(res?.status).toBe(200);
    const p = state.settings.providers.find((x) => x.id === KIMI_ID);
    expect(p?.authMode).toBe("oauth");
    expect(p?.oauth).toBeUndefined();
  });

  test("apiKey 供应商:authMode 正常跟随 body", async () => {
    seedProvider({ authMode: "apiKey", oauth: undefined });
    const res = await postProvider({ id: KIMI_ID, name: "Kimi Code", authMode: "apiKey" });
    expect(res?.status).toBe(200);
    const p = state.settings.providers.find((x) => x.id === KIMI_ID);
    expect(p?.authMode).toBe("apiKey");
  });

  test("restore 端点:把被冲成 apiKey 的预置订阅供应商拨回 oauth", async () => {
    seedProvider({ authMode: "apiKey", oauth: undefined });
    const res = await postRestore({ providerId: KIMI_ID });
    expect(res?.status).toBe(200);
    const p = state.settings.providers.find((x) => x.id === KIMI_ID);
    expect(p?.authMode).toBe("oauth");
  });

  test("restore 端点:非预置且无 oauth 行的供应商拒绝拨回", async () => {
    seedProvider({ id: "custom-provider", authMode: "apiKey", oauth: undefined });
    const res = await postRestore({ providerId: "custom-provider" });
    expect(res?.status).toBe(400);
  });
});
