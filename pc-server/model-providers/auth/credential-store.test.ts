// model-providers/auth/credential-store.test.ts — 锁 pi CredentialStore 在宿主 state 上的行为。
// 关键不变量(方案 §2.4):
//   1. 同一 provider 的 modify 串行化(并发刷新不双刷被轮换的 refresh token);
//   2. CAS:mutate 期间 refresh 被别处改写 → 本次写丢弃,返回当前实际凭证;
//   3. delete 剥 oauth + authMode 回 apiKey + enabled=false;
//   4. read/list 只读,不改 state。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPiCredentialStore } from "./credential-store";
import { setState, state } from "../../persistence/json-store";
import { updateSettings } from "../../app-config";
import { defaultSettings } from "../../app-config/defaults";
import type { Provider } from "../../foundation/types";

function seedProvider(id: string, refresh: string): void {
  const provider: Provider = {
    id,
    type: "openai",
    enabled: true,
    name: id,
    builtIn: false,
    shortDescription: "",
    description: "",
    apiKey: "",
    authMode: "oauth",
    oauth: { flow: "openai-codex", credential: { type: "oauth", access: "a", refresh, expires: Date.now() + 60000 }, signedInAt: 1 },
    baseUrl: "",
    models: [],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
  };
  // 直接 setState 而非 updateSettings:后者会经 normalizeState 回填预置供应商,
  // 覆盖测试想注入的精简 providers 列表。
  setState({ ...state, settings: { ...state.settings, providers: [...state.settings.providers, provider] } } as any);
}

function currentRefresh(id: string): string | undefined {
  return state.settings.providers.find((p) => p.id === id)?.oauth?.credential?.refresh as string | undefined;
}

describe("pi credential store", () => {
  beforeEach(() => {
    setState({ settings: structuredClone(defaultSettings()) } as any);
    seedProvider("p1", "r0");
  });
  afterEach(() => setState({ ...state, settings: { ...state.settings, providers: [] } } as any));

  test("read returns the stored credential", async () => {
    const store = createPiCredentialStore();
    const cred = await store.read("p1");
    expect(cred?.refresh).toBe("r0");
  });

  test("modify serializes concurrent mutations", async () => {
    const store = createPiCredentialStore();
    const order: string[] = [];
    const [a, b] = await Promise.all([
      store.modify("p1", async (cur) => {
        order.push(`a-enter:${cur?.refresh}`);
        await new Promise((r) => setTimeout(r, 30));
        return { type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 60000 };
      }),
      store.modify("p1", async (cur) => {
        order.push(`b-enter:${cur?.refresh}`);
        return { type: "oauth", access: "a2", refresh: "r2", expires: Date.now() + 60000 };
      }),
    ]);
    // 串行化:b 看到的是 a 写入后的 r1,而不是 r0。
    expect(order).toEqual(["a-enter:r0", "b-enter:r1"]);
    expect(currentRefresh("p1")).toBe("r2");
    expect(a?.refresh).toBe("r1");
    expect(b?.refresh).toBe("r2");
  });

  test("modify CAS: concurrent refresh change discards the write", async () => {
    const store = createPiCredentialStore();
    // mutate 期间外部把 refresh 改成 rX(模拟另一通道登录/注销),CAS 应丢弃本次写。
    const result = await store.modify("p1", async () => {
      updateSettings({
        ...state.settings,
        providers: state.settings.providers.map((p) =>
          p.id === "p1" ? { ...p, oauth: { ...p.oauth!, credential: { type: "oauth", access: "ax", refresh: "rX", expires: 1 } } } : p,
        ),
      });
      return { type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 60000 };
    });
    // 返回的是当前实际凭证(rX),不是被丢弃的 r1。
    expect(result?.refresh).toBe("rX");
    expect(currentRefresh("p1")).toBe("rX");
  });

  test("delete strips oauth and resets authMode/enabled", async () => {
    const store = createPiCredentialStore();
    await store.delete("p1");
    const provider = state.settings.providers.find((p) => p.id === "p1");
    expect(provider?.oauth).toBeUndefined();
    expect(provider?.authMode).toBe("apiKey");
    expect(provider?.enabled).toBe(true); // delete 不动 enabled(由调用方决定)
  });

  test("list enumerates oauth providers", async () => {
    seedProvider("p2", "r2");
    const store = createPiCredentialStore();
    const list = await store.list();
    expect(list.map((e) => e.providerId).sort()).toEqual(["p1", "p2"]);
    expect(list.every((e) => e.type === "oauth")).toBe(true);
  });

  test("read on missing provider resolves undefined", async () => {
    const store = createPiCredentialStore();
    expect(await store.read("nonexistent")).toBeUndefined();
  });
});
