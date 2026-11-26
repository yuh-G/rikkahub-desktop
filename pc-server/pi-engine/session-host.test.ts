// pi-engine/session-host.test.ts — 长驻会话(P5.6)的行为锁
//
// 经 runPiGeneration + session-host 跑多轮:视图与活会话一致时接着用(插件 session_start 只发一次,合成行
// 逐请求注入、不进会话条目);视图被改过时关掉重建;轮次之间插件 sendMessage({triggerTurn}) 变成开轮请求,
// 带回请求 id 的那一轮跑插件挂起的消息;invalidate 关掉空闲会话。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineEntry, EngineEntryInput, EngineSessionView, EngineTurnRequest } from "../engines/contract";
import { modelGrantFor } from "../engines/model-grant";
import type { Message } from "../foundation/types";
import { message } from "../foundation/utils";
import { model, provider } from "../model-providers";
import { sessionViewOf } from "../test-utils/engine-session-view";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";
import { createPiSessionResources } from "./resources";
import { runPiGeneration } from "./runner";
import { createPiSessionHost } from "./session-host";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-session-host-"));
const cwd = join(lab, "ws");
mkdirSync(cwd, { recursive: true });
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };

// 替身插件:生命周期事件记进全局日志;把 pi 句柄留给测试,模拟后台任务完成后 sendMessage。
const PLUGIN = `
const log = (globalThis.__rkhHostLog ??= []);
export default function (pi) {
  globalThis.__rkhHostPi = pi;
  pi.on("session_start", async () => { log.push("session_start"); });
  pi.on("before_agent_start", async () => { log.push("before_agent_start"); });
  pi.on("session_shutdown", async () => { log.push("session_shutdown"); });
}
`;
const pluginPath = join(lab, "host-plugin.js");
writeFileSync(pluginPath, PLUGIN);
const pluginLog = (): string[] => ((globalThis as Record<string, unknown>).__rkhHostLog ??= []) as string[];
const pluginApi = () => (globalThis as Record<string, unknown>).__rkhHostPi as { sendMessage: (message: unknown, options?: unknown) => void };

const requestTexts = (body: Record<string, unknown> | undefined) => JSON.stringify(body?.messages ?? []);

/** 一轮交出的条目 → 视图里那条助手消息的原生组(应用封存后下一轮原样给回)。 */
const nativeOf = (delivered: EngineEntryInput[]): EngineEntry[] =>
  delivered.map((entry, index) => ({ seq: index + 1, format: entry.format, entryId: entry.entryId ?? null, payload: JSON.parse(JSON.stringify(entry.payload)) }));

function viewWith(history: Message[], natives: Map<string, EngineEntry[]>, syntheticIds?: Set<string>): EngineSessionView {
  const view = sessionViewOf(history, { syntheticIds });
  for (const item of view.items) {
    const native = natives.get(item.message.id);
    if (native) item.native = native;
  }
  return view;
}

describe("长驻会话", () => {
  test("接着用、合成行逐请求注入、视图改过即重建、引擎发起的轮次、invalidate", async () => {
    const server = await startFakeOpenAiSse([{ content: "答1" }, { content: "答2" }, { content: "插件轮回答" }, { content: "重建后回答" }]);
    servers.push(server);
    const conversationId = "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const grant = modelGrantFor(provider({ id: crypto.randomUUID(), name: "Host", baseUrl: server.baseUrl, apiKey: "sk-test" }), model("fake-model", "Fake"), null, conversationId)!;
    const turnRequests: Array<Omit<EngineTurnRequest, "engine">> = [];
    const host = createPiSessionHost({ onTurnRequest: (req) => void turnRequests.push(req) });
    pluginLog().length = 0;

    const turn = async (view: EngineSessionView, promptText: string, trigger?: { requestId: string }) => {
      const delivered: EngineEntryInput[] = [];
      const result = await runPiGeneration({
        grant,
        conversationId,
        cwd,
        view,
        promptText,
        resources: (approvePluginTool) =>
          createPiSessionResources({ cwd, root: cwd, instructions, plugins: [{ id: "dev:host", path: pluginPath }], approvePluginTool }),
        appendEntries: async (entries) => void delivered.push(...entries),
        sessions: { host, key: "k" },
        ...(trigger ? { trigger } : {}),
        sink: () => undefined,
      });
      return { result, native: nativeOf(delivered) };
    };

    const u1 = message("USER", [{ type: "text", text: "问1" }]);
    const a1 = message("ASSISTANT", [{ type: "text", text: "答1" }], "fake-model");
    const u2 = message("USER", [{ type: "text", text: "问2" }]);
    const a2 = message("ASSISTANT", [{ type: "text", text: "答2" }], "fake-model");
    const a3 = message("ASSISTANT", [{ type: "text", text: "插件轮回答" }], "fake-model");
    const reminder = message("USER", [{ type: "text", text: "<time_reminder>T</time_reminder>" }]);
    const natives = new Map<string, EngineEntry[]>();

    // 第 1 轮:新建会话
    natives.set(a1.id, (await turn(sessionViewOf([]), "问1")).native);
    expect(pluginLog()).toEqual(["session_start", "before_agent_start"]);

    // 第 2 轮:视图与活会话一致 → 接着用;合成行(本轮起始之前)进请求,不进会话条目
    const second = await turn(viewWith([u1, a1, reminder], natives, new Set([reminder.id])), "问2");
    natives.set(a2.id, second.native);
    expect(pluginLog()).toEqual(["session_start", "before_agent_start", "before_agent_start"]);
    const request2 = requestTexts(server.requests[1]);
    const order = ["问1", "答1", "<time_reminder>T</time_reminder>", "问2"].map((text) => request2.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(JSON.stringify(second.native)).not.toContain("time_reminder");

    // 轮次之间插件要求再答一轮 → 不直接开跑,变成开轮请求
    pluginApi().sendMessage({ customType: "bg-result", content: "后台任务完成", display: true }, { triggerTurn: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnRequests).toHaveLength(1);
    expect(turnRequests[0]).toMatchObject({ conversationId, source: "" });
    expect(server.requests).toHaveLength(2);

    // 应用开轮(带回请求 id):跑插件挂起的消息;合成行这次锚在 u2 之前
    const third = await turn(viewWith([u1, a1, reminder, u2, a2], natives, new Set([reminder.id])), "", { requestId: turnRequests[0]!.requestId });
    natives.set(a3.id, third.native);
    expect(third.result.text).toBe("插件轮回答");
    const request3 = requestTexts(server.requests[2]);
    const order3 = ["问1", "答1", "<time_reminder>T</time_reminder>", "问2", "答2", "后台任务完成"].map((text) => request3.indexOf(text));
    expect(order3.every((index) => index >= 0)).toBe(true);
    expect([...order3].sort((a, b) => a - b)).toEqual(order3);
    expect(pluginLog().filter((item) => item === "session_start")).toHaveLength(1);

    // 视图被改过(编辑了 a1)→ 关掉重建:插件收尾一次、重新 session_start
    const edited = message("ASSISTANT", [{ type: "text", text: "答1(改)" }], "fake-model");
    edited.id = a1.id;
    await turn(viewWith([u1, edited, u2, a2], natives), "问4");
    expect(pluginLog().filter((item) => item === "session_shutdown")).toHaveLength(1);
    expect(pluginLog().filter((item) => item === "session_start")).toHaveLength(2);
    expect(requestTexts(server.requests[3])).toContain("答1(改)");

    // 已失效的开轮请求在建会话之前就以错误拒绝,活会话不受影响
    await expect(turn(viewWith([u1, edited, u2, a2], natives), "", { requestId: "gone" })).rejects.toThrow("已失效");
    expect(pluginLog().filter((item) => item === "session_shutdown")).toHaveLength(1);

    // invalidate 关掉空闲的会话
    await host.invalidate(conversationId);
    expect(pluginLog().filter((item) => item === "session_shutdown")).toHaveLength(2);
  }, 60_000);
});
