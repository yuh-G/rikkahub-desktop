// api/settings-provider-oauth.test.ts — 订阅供应商 POST 保存的 authMode 保护锁。
// 关键不变量(方案 §3):
//   1. 已登录的订阅供应商(authMode=oauth):前端 draft 的滞后 authMode 不得覆盖服务端真值;
//   2. 未登录的订阅供应商(authMode=oauth):服务端真值同样优先,前端误传 apiKey 不得改形态;
//   3. apiKey 供应商:authMode 正常跟随 body(用户可切形态);
//   4. 前端回传的派生视图 oauthStatus 不得落进 state。
// (历史数据里已被冲成 apiKey 的预置行由 normalizeState 加载时拨回,见 persistence 的
//  provider-oauth-status-strip.test.ts;不再有 restore 端点。)

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

  test("前端回传的 oauthStatus 派生视图不得落进 state(否则登出后残留 signedIn:true)", async () => {
    // 前端 draft 是 stripAuthSecrets 下发的形状(带 oauthStatus),整对象回传是常态。
    const res = await postProvider({
      id: KIMI_ID,
      name: "Kimi Code (renamed)",
      authMode: "oauth",
      oauthStatus: { signedIn: true, flow: "kimi-coding", signedInAt: 1 },
    });
    expect(res?.status).toBe(200);
    const p = state.settings.providers.find((x) => x.id === KIMI_ID) as Record<string, unknown> | undefined;
    expect(p?.name).toBe("Kimi Code (renamed)");
    expect("oauthStatus" in (p ?? {})).toBe(false);
    // 服务端凭证照旧保留
    expect((p?.oauth as { credential?: { refresh?: string } } | undefined)?.credential?.refresh).toBe("r");
  });

  test("oauth/status 端点:无进行中尝试时 inProgress=false、event=null", async () => {
    const url = new URL(`http://127.0.0.1/api/settings/provider/oauth/status?providerId=${KIMI_ID}`);
    const res = await handleSettingsRoutes(new Request(url), url, "settings/provider/oauth/status");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ inProgress: false, event: null });
  });
});
