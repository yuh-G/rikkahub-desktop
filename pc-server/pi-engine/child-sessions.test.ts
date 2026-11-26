// pi-engine/child-sessions.test.ts — 插件另开的 pi 会话受应用约束(P5.9)
//
// 替身子代理插件:登记一个工具,执行时经虚拟模块拿到 pi 的 createAgentSession,另开一个默认工具(pi 默认后端)
// 的会话跑子任务。锁定:①插件拿到的就是应用这份 pi(原型上的约束对它生效);②子会话的内建工具经发起这一轮的
// 审批口判定(来源 engine、noPrompt),default 放行范围下区外写入与危险命令被拒、区内照常;③这一轮没有工作区工具时
// 子会话的内建工具一律拒绝。「本程序被当作 pi 命令行再启动」的识别在 foundation/process-roles.test.ts。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnginePlugin } from "../engines/contract";
import { modelGrantFor } from "../engines/model-grant";
import { model, provider } from "../model-providers";
import { sessionViewOf } from "../test-utils/engine-session-view";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";
import type { PiBuiltinToolApproval } from "./builtin-tools";
import { createPiSessionResources } from "./resources";
import { runPiGeneration } from "./runner";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-pi-child-"));
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const childAgentDir = join(lab, "child-agent");
mkdirSync(childAgentDir, { recursive: true });
const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: [] } };
const shared = () => globalThis as unknown as Record<string, unknown>;
shared().__rkhChildAgentDir = childAgentDir;

const SUBAGENT_PLUGIN = `
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
export default function (pi) {
  pi.registerTool({
    name: "spawn_child",
    label: "spawn_child",
    description: "run a sub-task",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        agentDir: globalThis.__rkhChildAgentDir,
        modelRuntime: ctx.modelRegistry.runtime,
        model: ctx.model,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        settingsManager: SettingsManager.inMemory(),
      });
      await session.prompt("do the sub-task");
      globalThis.__rkhChildResults = session.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => ({ tool: message.toolName, isError: message.isError, text: message.content.map((block) => block.text ?? "").join("") }));
      session.dispose();
      return { content: [{ type: "text", text: "child done" }], details: {} };
    },
  });
}
`;

function writeWorkspace(name: string): { cwd: string; outside: string } {
  const cwd = join(lab, name, "ws");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "notes.md"), "hello from notes");
  return { cwd, outside: join(lab, name, "outside.txt") };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });
const DANGER = "true || rm -rf /usr/rkh-never-exists";

async function runParentTurn(cwd: string, outside: string, workspace: boolean) {
  const server = await startFakeOpenAiSse([
    { toolCalls: [call("p-1", "spawn_child", {})] },
    {
      toolCalls: [
        call("c-out", "write", { path: outside, content: "x" }),
        call("c-in", "write", { path: join(cwd, "inside.txt"), content: "y" }),
        call("c-bash", "bash", { command: DANGER }),
        call("c-read", "read", { path: "notes.md" }),
      ],
    },
    { content: "子任务完成" },
    { content: "完成" },
  ]);
  servers.push(server);
  const pluginFile = join(lab, `subagent-${crypto.randomUUID()}.js`);
  writeFileSync(pluginFile, SUBAGENT_PLUGIN);
  const plugin: EnginePlugin = { id: "dev:subagent", path: pluginFile };
  const approvePluginTool = async () => undefined;
  const resources = await createPiSessionResources({ cwd, root: cwd, instructions, plugins: [plugin], approvePluginTool });
  const approvals: PiBuiltinToolApproval[] = [];
  shared().__rkhChildResults = undefined;
  const result = await runPiGeneration({
    grant: modelGrantFor(provider({ id: crypto.randomUUID(), name: "Child", baseUrl: server.baseUrl, apiKey: "sk-test" }), model("fake-model", "Fake"), null, "conv-child")!,
    conversationId: "conv-child",
    cwd,
    view: sessionViewOf([]),
    promptText: "派个子任务",
    resources,
    approvePluginTool,
    ...(workspace
      ? {
          workspaceTools: {
            root: cwd,
            approve: async (req: PiBuiltinToolApproval) => {
              approvals.push(req);
              return { scope: "default" as const };
            },
          },
        }
      : {}),
    sink: () => undefined,
  });
  const childResults = shared().__rkhChildResults as Array<{ tool: string; isError: boolean; text: string }>;
  return { result, approvals, childResults: Object.fromEntries(childResults.map((item, index) => [["out", "in", "bash", "read"][index]!, item])) };
}

describe("插件另开的会话", () => {
  test("内建工具经本轮审批口判定(noPrompt);default 范围下区外写入与危险命令被拒,区内照常", async () => {
    const { cwd, outside } = writeWorkspace("with-ws");
    const { result, approvals, childResults } = await runParentTurn(cwd, outside, true);
    expect(result.text).toBe("完成");
    expect(approvals.map((req) => [req.toolName, req.category, req.target, req.noPrompt])).toEqual([
      ["write", "write", { path: outside }, true],
      ["write", "write", { path: join(cwd, "inside.txt") }, true],
      ["bash", "execute", { command: DANGER }, true],
      ["read", "read", { path: join(cwd, "notes.md") }, true],
    ]);
    expect(childResults.out).toMatchObject({ isError: true, text: expect.stringContaining("outside the workspace boundary") });
    expect(existsSync(outside)).toBe(false);
    expect(childResults.in!.isError).toBe(false);
    expect(readFileSync(join(cwd, "inside.txt"), "utf8")).toBe("y");
    expect(childResults.bash).toMatchObject({ isError: true, text: expect.stringContaining("Command blocked by safety policy") });
    expect(childResults.read).toMatchObject({ isError: false, text: expect.stringContaining("hello from notes") });
  }, 30_000);

  test("这一轮没有工作区工具:子会话的内建工具一律拒绝", async () => {
    const { cwd, outside } = writeWorkspace("no-ws");
    const { result, approvals, childResults } = await runParentTurn(cwd, outside, false);
    expect(result.text).toBe("完成");
    expect(approvals).toEqual([]);
    for (const item of Object.values(childResults)) {
      expect(item).toMatchObject({ isError: true, text: expect.stringContaining("built-in tools are unavailable") });
    }
    expect(existsSync(join(cwd, "inside.txt"))).toBe(false);
  }, 30_000);
});
