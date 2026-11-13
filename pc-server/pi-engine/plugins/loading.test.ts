// pi-engine/plugins/loading.test.ts — 插件加载(P5.2):清单 → 入口文件 → pi 资源加载器 → 会话生命周期
//
// 锁定:①清单为空时加载器配置与插件接入前相同(没有扩展、没有错误);②替身插件真的被加载,
// 插件包里声明的技能不会借道进会话;③session_start 在首个请求前送达(插件在这里重放状态),
// session_shutdown 在会话收尾时送达;④没有审批口时(这里不传 approvePluginTool)插件工具不进会话工具集;
// ⑤插件 appendEntry 写的私有条目经 appendEntries 交给应用;⑥路径错误、模块错误、处理函数抛错
// 都进错误中心并署插件 id,不挡住这一轮。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineEntryInput, EngineErrorReport, EnginePlugin } from "../../engines/contract";
import { modelGrantFor } from "../../engines/model-grant";
import { model, provider } from "../../model-providers";
import { sessionViewOf } from "../../test-utils/engine-session-view";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../../test-utils/fake-openai-sse";
import { createPiSessionResources } from "../resources";
import { runPiGeneration } from "../runner";

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const lab = mkdtempSync(join(tmpdir(), "rkh-pi-plugins-"));
const cwd = join(lab, "ws");
mkdirSync(cwd, { recursive: true });
const skillsDir = join(lab, "skills");
mkdirSync(skillsDir, { recursive: true });
const instructions = { appendSystemPrompt: [], globalAgentsFile: null, skills: { dir: skillsDir, enabled: ["sneaky-skill"] } };

// 替身插件:每个事件记一笔到全局日志(测试与插件同进程),session_start 时写一条私有条目,
// 登记一个工具,input 事件里抛错(验证错误署名)。
const STAND_IN = `
const log = (globalThis.__rkhPluginLog ??= []);
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    log.push({ event: "session_start", sessionId: ctx.sessionManager.getSessionId(), mode: ctx.mode });
    pi.appendEntry("stand-in-state", { replayed: true });
  });
  pi.on("before_agent_start", async () => { log.push({ event: "before_agent_start" }); });
  pi.on("input", async () => { throw new Error("stand-in input boom"); });
  pi.on("session_shutdown", async (event) => { log.push({ event: "session_shutdown", reason: event.reason }); });
  pi.registerTool({
    name: "stand_in_tool",
    label: "stand_in_tool",
    description: "stand-in tool",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ran" }], details: {} }; },
  });
}
`;

function writeStandInPackage(): string {
  const dir = join(lab, "stand-in");
  mkdirSync(join(dir, "skills", "sneaky-skill"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stand-in", type: "module", pi: { extensions: ["./main.js"], skills: ["./skills"] } }));
  writeFileSync(join(dir, "main.js"), STAND_IN);
  writeFileSync(join(dir, "skills", "sneaky-skill", "SKILL.md"), "---\nname: sneaky-skill\ndescription: must not load\n---\n\nbody\n");
  return dir;
}

const pluginLog = (): Array<Record<string, unknown>> => ((globalThis as Record<string, unknown>).__rkhPluginLog ??= []) as Array<Record<string, unknown>>;

describe("插件加载", () => {
  test("清单为空:不加载任何扩展,也没有加载错误", async () => {
    const resources = await createPiSessionResources({ cwd, root: cwd, instructions, plugins: [] });
    expect(resources.plugins).toEqual([]);
    expect(resources.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(resources.resourceLoader.getExtensions().errors).toEqual([]);
  });

  test("包目录按 pi.extensions 展开成入口文件;包里声明的技能不进会话", async () => {
    const plugin: EnginePlugin = { id: "dev:stand-in", path: writeStandInPackage() };
    const resources = await createPiSessionResources({ cwd, root: cwd, instructions, plugins: [plugin] });
    expect(resources.plugins.map((entry) => entry.pluginId)).toEqual(["dev:stand-in"]);
    expect(resources.resourceLoader.getExtensions().extensions.map((ext) => ext.path)).toEqual([join(plugin.path, "main.js")]);
    expect(resources.resourceLoader.getExtensions().errors).toEqual([]);
    expect(resources.resourceLoader.getSkills().skills).toEqual([]);
  });

  test("一轮生成:session_start 在请求前、session_shutdown 在收尾;插件工具不进会话;私有条目交给应用;处理函数抛错署名进错误中心", async () => {
    const server = await startFakeOpenAiSse([{ content: "好的" }]);
    servers.push(server);
    const plugin: EnginePlugin = { id: "dev:stand-in", path: writeStandInPackage() };
    const reports: EngineErrorReport[] = [];
    const resources = await createPiSessionResources({ cwd, root: cwd, instructions, plugins: [plugin], report: (r) => void reports.push(r) });
    const appended: EngineEntryInput[] = [];
    pluginLog().length = 0;
    const ourProvider = provider({ id: crypto.randomUUID(), name: "Plugin Test", baseUrl: server.baseUrl, apiKey: "sk-test" });
    const ourModel = model("fake-model", "Fake");
    const result = await runPiGeneration({
      grant: modelGrantFor(ourProvider, ourModel, null, "conv-plugin-1")!,
      conversationId: "conv-plugin-1",
      cwd,
      view: sessionViewOf([], { model: ourModel }),
      promptText: "你好",
      resources,
      report: (r) => void reports.push(r),
      appendEntries: async (entries) => void appended.push(...entries),
      sink: () => undefined,
    });
    expect(result.text).toBe("好的");

    const events = pluginLog().map((item) => item.event);
    expect(events[0]).toBe("session_start");
    expect(pluginLog()[0]).toMatchObject({ sessionId: "conv-plugin-1", mode: "rpc" });
    expect(events).toContain("before_agent_start");
    expect(events.at(-1)).toBe("session_shutdown");
    expect(pluginLog().at(-1)).toMatchObject({ reason: "quit" });

    const declared = (server.requests[0]!.tools as Array<{ function: { name: string } }> | undefined) ?? [];
    expect(declared.map((tool) => tool.function.name)).not.toContain("stand_in_tool");

    const custom = appended.map((entry) => entry.payload as Record<string, unknown>).filter((payload) => payload.type === "custom");
    expect(custom).toEqual([expect.objectContaining({ customType: "stand-in-state", data: { replayed: true } })]);

    expect(reports).toEqual([
      expect.objectContaining({ code: "pi_plugin_runtime_error", params: { plugin: "dev:stand-in", event: "input", error: "stand-in input boom" } }),
    ]);
  }, 20_000);

  test("路径不存在、找不到入口、模块报错:逐条署名报 warn,其余插件照常加载", async () => {
    const good: EnginePlugin = { id: "dev:stand-in", path: writeStandInPackage() };
    const emptyDir = join(lab, "empty-plugin");
    mkdirSync(emptyDir, { recursive: true });
    const broken = join(lab, "broken.js");
    writeFileSync(broken, "export default function () { throw new Error('factory boom'); }\n");
    const reports: EngineErrorReport[] = [];
    const resources = await createPiSessionResources({
      cwd,
      root: cwd,
      instructions,
      plugins: [
        { id: "dev:missing", path: join(lab, "does-not-exist") },
        { id: "dev:empty", path: emptyDir },
        { id: "dev:broken", path: broken },
        good,
      ],
      report: (r) => void reports.push(r),
    });
    expect(resources.resourceLoader.getExtensions().extensions.map((ext) => ext.path)).toEqual([join(good.path, "main.js")]);
    const failed = reports.filter((r) => r.code === "pi_plugin_load_failed").map((r) => r.params?.plugin);
    expect(failed).toEqual(["dev:missing", "dev:empty", "dev:broken"]);
    expect(reports.find((r) => r.params?.plugin === "dev:broken")?.params?.error).toContain("factory boom");
  });
});
