// conversations/oauth-aux-stream.test.ts — 订阅供应商辅助调用的 streamingOnly 强制流式锁。
// 纪律:声明 streamingOnly 的 flow(Codex 端点只收 SSE),fetchAuxiliaryText 即便调用方
// 没传 stream 也必须改走流式收集(标题/建议/提示词优化都不传 stream);未声明的 flow
// 保持调用方原意(非流式直发)。整形(头/body)与主生成路径同一时机,一并锁进。

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-oauth-aux-test-"));

import { setState, state } from "../persistence/json-store";
import { defaultSettings } from "../app-config/defaults";
import { model } from "../model-providers";
import { overrideOAuthFlow } from "../model-providers/auth/flows";
import { fetchAuxiliaryText } from "./auxiliary";
import type { Provider } from "../foundation/types";

function oauthProvider(overrides: Partial<Provider>): Provider {
  return {
    id: "98d0557b-0700-41e5-b1d6-ee875a53ae5a",
    type: "openai",
    enabled: true,
    name: "ChatGPT(Codex)",
    builtIn: true,
    shortDescription: "",
    description: "",
    apiKey: "",
    authMode: "oauth",
    oauth: {
      flow: "openai-codex",
      credential: { type: "oauth", access: "acc-x", refresh: "r-x", expires: Date.now() + 3600_000, accountId: "acct_42" },
      signedInAt: 1,
    },
    baseUrl: "https://chatgpt.com/backend-api/codex",
    useResponseApi: true,
    models: [{ id: "m1", modelId: "gpt-5-codex", name: "GPT-5 Codex" }],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
    ...overrides,
  } as Provider;
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  // fetchAuxiliaryText 会 addLog(读 state.stats/logs):测试进程未跑 bootstrap,补最小字段。
  setState({ ...state, stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} }, logs: [], settings: structuredClone(defaultSettings()) } as never);
  setState({
    ...state,
    settings: {
      ...state.settings,
      chatModelId: "m1",
      providers: [oauthProvider({})],
    },
  } as never);
  overrideOAuthFlow("openai-codex", {
    name: "Test Codex",
    login: async () => {
      throw new Error("not in test");
    },
    refresh: async () => {
      throw new Error("not in test");
    },
    toAuth: async (cred) => ({ apiKey: cred.access }),
  });
});

describe("fetchAuxiliaryText:streamingOnly flow 强制流式收集", () => {
  test("调用方未传 stream:Codex 请求仍 stream:true + 整形完整,文本经流收集返回", async () => {
    const originalFetch = globalThis.fetch;
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return sseResponse([{ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hi" } }]);
    }) as unknown as typeof fetch;
    try {
      const text = await fetchAuxiliaryText("m1", "summarize", "title");
      expect(text).toBe("Hi");
      const hit = captured as never as { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null;
      expect(hit?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(hit?.body.stream).toBe(true);
      expect(hit?.body.include).toContain("reasoning.encrypted_content");
      expect("max_output_tokens" in (hit?.body ?? {})).toBe(false);
      expect(hit?.headers.Authorization).toBe("Bearer acc-x");
      expect(hit?.headers["chatgpt-account-id"]).toBe("acct_42");
      expect(hit?.headers["OpenAI-Beta"]).toBe("responses=experimental");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("未声明 streamingOnly 的 flow(Kimi):调用方不传 stream 就非流式直发", async () => {
    setState({
      ...state,
      settings: {
        ...state.settings,
        providers: [
          oauthProvider({
            id: "f9622c8b-5037-4540-b875-3d301521367b",
            name: "Kimi Code",
            type: "claude",
            baseUrl: "https://api.kimi.com/coding",
            useResponseApi: false,
            oauth: {
              flow: "kimi-coding",
              credential: { type: "oauth", access: "k-acc", refresh: "k-r", expires: Date.now() + 3600_000 },
              signedInAt: 1,
            },
            models: [{ ...model("kimi-for-coding", "Kimi"), id: "k1" }],
          }),
        ],
      },
    } as never);
    overrideOAuthFlow("kimi-coding", {
      name: "Test Kimi",
      login: async () => {
        throw new Error("not in test");
      },
      refresh: async () => {
        throw new Error("not in test");
      },
      toAuth: async (cred) => ({ apiKey: cred.access }),
    });
    const originalFetch = globalThis.fetch;
    let captured: { body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      captured = { body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const text = await fetchAuxiliaryText("k1", "summarize", "title");
      expect(text).toBe("ok");
      const hit = captured as never as { body: Record<string, unknown>; headers: Record<string, string> } | null;
      expect(hit?.body.stream).toBe(false);
      expect(hit?.headers.Authorization).toBe("Bearer k-acc");
      expect("x-api-key" in (hit?.headers ?? {})).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
