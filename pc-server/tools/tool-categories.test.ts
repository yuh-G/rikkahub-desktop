// tools/tool-categories.test.ts — 应用工具映射表:声明出来的每个工具都有类别;工作区工具名不在表里(由 pi 驱动带表)
import { describe, expect, test } from "bun:test";
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
    const names = declaredGeneralToolNames();
    expect(names).toContain("mcp__do_it");
    for (const name of names) expect(classifyAppTool(name)).not.toBeNull();
  });

  test("类别:联网工具 network;应用自己的功能 local;ask_user 是 ask;mcp__* 是 mcp", () => {
    const expected: Record<string, ToolCategory> = {
      search_web: "network", scrape_web: "network",
      use_skill: "local", save_memory: "local", get_time_info: "local", clipboard_tool: "local", text_to_speech: "local",
      ask_user: "ask", mcp__do_it: "mcp",
    };
    for (const [name, category] of Object.entries(expected)) expect(classifyAppTool(name)?.category).toBe(category);
  });

  test("对象提取:抓取取 url;形状不对时不编造", () => {
    expect(classifyAppTool("scrape_web")!.target({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
    expect(classifyAppTool("scrape_web")!.target({ url: 3 })).toEqual({});
    expect(classifyAppTool("save_memory")!.target({ content: "x" })).toEqual({});
  });

  test("不认识的名字不在表里(原型链上的键也不算);工作区工具名归 pi 驱动的表,这里不认", () => {
    for (const name of ["", "unknown_tool", "constructor", "toString", "__proto__", "read", "write", "edit", "bash", "grep", "find", "ls"]) {
      expect(classifyAppTool(name)).toBeNull();
    }
  });
});
