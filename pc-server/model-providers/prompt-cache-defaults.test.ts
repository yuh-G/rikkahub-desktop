// model-providers/prompt-cache-defaults.test.ts — 「Claude 提示缓存」按端点取默认(方案 §5.17.3,D31)
//
// 锁四件事:①默认值表(官方 / 中转站 / 订阅 / 非 Claude);②生效值 = 用户设过的值优先;③聊天引擎请求在官方端点
// 默认带 cache_control;④没有第二处按字面读 promptCaching(源码扫描:生产代码只许本模块与登记的几处读这个字段)。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { Provider } from "../foundation/types";
import { claudeMessagesFromApiMessages, claudeSystemContent, claudeToolsFromOpenAiTools } from "../inference-engine/message-builder";
import { promptCachePolicyFor } from "../engines/model-grant";
import { provider } from "./index";
import { claudePromptCachingDefault, claudePromptCachingEnabled } from "./prompt-cache-defaults";

const row = (overrides: Partial<Provider>) => provider({ id: crypto.randomUUID(), name: "T", baseUrl: "https://api.anthropic.com/v1", type: "claude", ...overrides });

describe("默认值表", () => {
  test("Claude 格式、API Key、官方主机 → 开;主机写法不影响(带不带 /v1、尾斜杠)", () => {
    for (const baseUrl of ["https://api.anthropic.com/v1", "https://api.anthropic.com", "https://api.anthropic.com/"]) {
      expect(claudePromptCachingDefault(row({ baseUrl }))).toBe(true);
    }
  });

  test("中转站、看起来像官方的主机、非法地址 → 关", () => {
    for (const baseUrl of ["https://relay.example.com/v1", "https://api.anthropic.com.evil.example", "https://proxy.example/api.anthropic.com", "not a url", ""]) {
      expect(claudePromptCachingDefault(row({ baseUrl }))).toBe(false);
    }
  });

  test("订阅行 → 关(它们的缓存由授权恒开,字段不起作用);OpenAI / Google 格式 → 关", () => {
    expect(claudePromptCachingDefault(row({ authMode: "oauth" }))).toBe(false);
    expect(claudePromptCachingDefault(row({ type: "openai" }))).toBe(false);
    expect(claudePromptCachingDefault(row({ type: "google" }))).toBe(false);
  });

  test("生效值:用户设过 true / false 就用它,不填才取默认", () => {
    expect(claudePromptCachingEnabled(row({}))).toBe(true);
    expect(claudePromptCachingEnabled(row({ promptCaching: false }))).toBe(false);
    expect(claudePromptCachingEnabled(row({ baseUrl: "https://relay.example.com", promptCaching: true }))).toBe(true);
    expect(claudePromptCachingEnabled(row({ baseUrl: "https://relay.example.com" }))).toBe(false);
  });

  test("出厂的供应商行不再写死 promptCaching(不填 = 按端点取默认)", () => {
    expect("promptCaching" in provider({ id: "x", name: "X", baseUrl: "https://api.anthropic.com/v1" })).toBe(false);
  });
});

describe("两个引擎读同一个生效值", () => {
  const official = row({});
  const relay = row({ baseUrl: "https://relay.example.com/v1" });

  test("聊天引擎:官方端点不填时 system / tools / 倒数第二条 user 都带 cache_control;中转站不填时都不带", () => {
    const tools = [{ function: { name: "a", parameters: { type: "object", properties: {} } } }];
    const messages = [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }] as never;
    expect((claudeSystemContent("sys", official) as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect((claudeToolsFromOpenAiTools(tools, official) as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(claudeMessagesFromApiMessages(messages, official)[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect((claudeSystemContent("sys", relay) as any[])[0].cache_control).toBeUndefined();
    expect((claudeToolsFromOpenAiTools(tools, relay) as any[])[0].cache_control).toBeUndefined();
    expect(claudeMessagesFromApiMessages(messages, relay)[0].content[0].cache_control).toBeUndefined();
  });

  test("工作区授权:官方端点不填 = 开,用户关了 = 关,中转站不填 = 关", () => {
    expect(promptCachePolicyFor(official).enabled).toBe(true);
    expect(promptCachePolicyFor(row({ promptCaching: false })).enabled).toBe(false);
    expect(promptCachePolicyFor(relay).enabled).toBe(false);
  });
});

const serverRoot = resolve(import.meta.dir, "..");
/** 允许按字面读 `.promptCaching` 的生产文件:默认值模块本身、加载时的一次性迁移、给 APP 的导出(判断是否已有显式值)。 */
const ALLOWED_READERS = new Set(["model-providers/prompt-cache-defaults.ts", "persistence/state-load.ts", "backup/export.ts"]);

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "scripts") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

test("源码扫描:只有登记的文件按字面读 promptCaching,其余都经 claudePromptCachingEnabled", () => {
  const offenders = productionFiles(serverRoot)
    .map((file) => relative(serverRoot, file).split(sep).join("/"))
    .filter((file) => !file.startsWith("test-utils/") && !ALLOWED_READERS.has(file))
    .filter((file) => /\.promptCaching\b/.test(readFileSync(join(serverRoot, file), "utf8")));
  expect(offenders).toEqual([]);
  const webUi = resolve(serverRoot, "..", "web-ui", "app", "components", "settings", "providers", "index.tsx");
  expect(readFileSync(webUi, "utf8")).not.toMatch(/\.promptCaching\b/);
});
