// tools/tool-categories.test.ts — 应用工具映射表:声明出来的每个工具都有类别,类别与按名判定时逐项相同
import { describe, expect, test } from "bun:test";
import { WORKSPACE_TOOL_NAMES } from "../workspace/approval";
import { openAiLocalTools, openAiMcpTools, openAiSearchTools, openAiSkillTools } from "./definitions";
import type { ToolCategory } from "./permission";
import { classifyAppTool } from "./tool-categories";

const assistant = {
  id: "a1",
  localTools: ["time_info", "clipboard", "tts", "ask_user"],
  enableMemory: true,
  enabledSkills: ["demo"],
  mcpServers: ["s1"],
} as never;

function declaredGeneralToolNames(): string[] {
  const mcpServers = [{ id: "s1", commonOptions: { enable: true, name: "S", tools: [{ name: "do it", enable: true }] } }];
  return [
    ...openAiSearchTools(true),
    ...openAiSkillTools(assistant, () => [{ name: "demo", description: "d" }] as never),
    ...openAiLocalTools(assistant, { globalEnabled: true, writeStrategy: "ask" }),
    ...openAiMcpTools(assistant, mcpServers as never),
  ].map((tool) => tool.function.name);
}

describe("应用工具映射表", () => {
  test("声明出来的每个应用工具都在表里(新增工具必须登记类别)", () => {
    const names = [...WORKSPACE_TOOL_NAMES, ...declaredGeneralToolNames()];
    expect(names).toContain("mcp__do_it");
    for (const name of names) expect(classifyAppTool(name)).not.toBeNull();
  });

  test("类别:工作区按读 / 写 / 执行分;联网工具 network;应用自己的功能 local;ask_user 是 ask;mcp__* 是 mcp", () => {
    const expected: Record<string, ToolCategory> = {
      read: "read", grep: "read", find: "read", ls: "read",
      write: "write", edit: "write", bash: "execute",
      search_web: "network", scrape_web: "network",
      use_skill: "local", save_memory: "local", get_time_info: "local", clipboard_tool: "local", text_to_speech: "local",
      ask_user: "ask", mcp__do_it: "mcp",
    };
    for (const [name, category] of Object.entries(expected)) expect(classifyAppTool(name)?.category).toBe(category);
  });

  test("对象提取:写入 / 读取取 path,执行取 command,抓取取 url;形状不对时不编造", () => {
    expect(classifyAppTool("write")!.target({ path: "a.txt", content: "x" })).toEqual({ path: "a.txt" });
    expect(classifyAppTool("edit")!.target({ path: 3 })).toEqual({});
    expect(classifyAppTool("bash")!.target({ command: "ls" })).toEqual({ command: "ls" });
    expect(classifyAppTool("bash")!.target({})).toEqual({ command: "" });
    expect(classifyAppTool("scrape_web")!.target({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
    expect(classifyAppTool("save_memory")!.target({ content: "x" })).toEqual({});
  });

  test("不认识的名字不在表里(原型链上的键也不算)", () => {
    for (const name of ["", "unknown_tool", "constructor", "toString", "__proto__"]) expect(classifyAppTool(name)).toBeNull();
  });
});
