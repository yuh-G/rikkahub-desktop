// pi-engine/user-agent.test.ts — 工作区请求的 User-Agent 行为锁(P2.3c)
//
// pi 自己给每个请求带 `pi/<版本> (…)`,宿主 fetch 壳对已带 UA 的请求不覆盖,所以 UA 必须经 pi
// 的 identity 请求选项送进去。测试进程不装 fetch 壳,假上游收到的就是 pi 发出的原样头。
// 锁:API Key 授权的会话请求与压缩摘要请求都发授权里的应用 UA;供应商自定义 User-Agent 头仍
// 优先;订阅授权不包装(通道身份由 pi 内建定义维护)。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "../../pi/packages/coding-agent/src/core/model-runtime.ts";
import { getDefaultUserAgent } from "../foundation/net";
import { message } from "../foundation/utils";
import { modelGrantFor } from "../engines/model-grant";
import { model, provider } from "../model-providers";
import { OAUTH_FLOWS } from "../model-providers/auth";
import { sessionViewOf } from "../test-utils/engine-session-view";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";
import { createPiModelRuntime, mapGrantToPi } from "./model-bridge";
import { runPiCompaction, runPiGeneration } from "./runner";

let server: FakeOpenAiSseServer;
let cwd: string;

beforeAll(async () => {
  server = await startFakeOpenAiSse([{ content: "一" }, { content: "二" }, { content: "三" }, { content: "压缩摘要" }]);
  cwd = mkdtempSync(join(tmpdir(), "pi-user-agent-"));
});

afterAll(async () => {
  await server.close();
});

const fakeModel = model("fake-model", "Fake");

function row(extra: Record<string, unknown> = {}) {
  return provider({ id: crypto.randomUUID(), name: "UA Provider", baseUrl: server.baseUrl, apiKey: "sk-test", ...extra });
}

async function runTurn(grantUserAgent: string | undefined, extra: Record<string, unknown> = {}): Promise<string | undefined> {
  const before = server.requestHeaders.length;
  const conversationId = crypto.randomUUID();
  await runPiGeneration({
    grant: modelGrantFor(row(extra), fakeModel, null, conversationId, grantUserAgent)!,
    conversationId,
    cwd,
    view: sessionViewOf([]),
    promptText: "你好",
    sink: () => {},
  });
  const header = server.requestHeaders[before]?.["user-agent"];
  return Array.isArray(header) ? header[0] : header;
}

describe("API Key 授权:请求以应用身份 UA 发出", () => {
  test("缺省为品牌 UA,不再是 pi 的 UA", async () => {
    const ua = await runTurn(undefined);
    expect(ua).toBe(getDefaultUserAgent());
    expect(ua?.startsWith("pi/")).toBe(false);
  });

  test("授权里的自定义 UA 原样发出", async () => {
    expect(await runTurn("MyClient/9.9")).toBe("MyClient/9.9");
  });

  test("供应商自定义 User-Agent 头优先于应用 UA", async () => {
    const ua = await runTurn("MyClient/9.9", { customHeaders: [{ name: "User-Agent", value: "Vendor-Required/1.0" }] });
    expect(ua).toBe("Vendor-Required/1.0");
  });

  test("压缩摘要请求同样发应用 UA", async () => {
    const filler = "很长的历史内容,".repeat(12000);
    const history = [
      message("USER", [{ type: "text", text: `问题${filler}` }]),
      message("ASSISTANT", [{ type: "text", text: `回答${filler}` }]),
    ];
    const before = server.requestHeaders.length;
    await runPiCompaction({
      grant: modelGrantFor(row(), fakeModel, null, "conv-ua-compact", "MyClient/9.9")!,
      conversationId: "conv-ua-compact",
      cwd,
      view: sessionViewOf(history, { model: fakeModel }),
      sink: () => {},
    });
    const sent = server.requestHeaders.slice(before).map((headers) => headers["user-agent"]);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((ua) => ua === "MyClient/9.9")).toBe(true);
  }, 20_000);
});

test("订阅授权不包装运行时:通道身份保留 pi 内建定义(Kimi Coding 等按客户端白名单放行)", async () => {
  const flow = OAUTH_FLOWS["kimi-coding"];
  const kimi = provider({
    id: flow.presetProviderId,
    name: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding",
    type: "claude",
    authMode: "oauth",
  });
  const mapped = mapGrantToPi(modelGrantFor(kimi, model("k3"), null, "conv-ua-kimi", "MyClient/9.9")!);
  if (!mapped.ok) throw new Error(mapped.reason);
  expect(mapped.mapping.kind).toBe("builtin");
  const { runtime } = await createPiModelRuntime(mapped.mapping);
  expect(runtime.streamSimple).toBe(ModelRuntime.prototype.streamSimple);
});
