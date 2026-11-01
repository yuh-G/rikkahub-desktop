// C1(专题11复查):Claude prompt caching 契约测试——移植安卓 ClaudeProviderPromptCacheTest。
// 复查文档曾断言"PC 全库无 cache_control",实为误判:实现自 V1.0.0 起就在(orchestrator 顶层
// 断点 + message-builder 三个块级断点),但 PC 侧一直没有对应回归测试,契约无锁。本文件
// 按安卓测试用例逐条锁定:开关关=零标记;开=system 末块/tools 末项/倒数第二条真实 user
// 消息末块;5m 默认不发 ttl,1h 显式发;tool_result 消息不算真实 user 消息。
import { describe, expect, test } from "bun:test";

import {
  claudeCacheControlEphemeral,
  claudeMessagesFromApiMessages,
  claudeSystemContent,
  claudeToolsFromOpenAiTools,
} from "./message-builder";
import type { ApiMessage, Provider } from "../foundation/types";

const cachingOff = { type: "claude", promptCaching: false } as unknown as Provider;
const cachingOn = { type: "claude", promptCaching: true } as unknown as Provider;
const cachingOn1h = { type: "claude", promptCaching: true, promptCacheTtl: "1h" } as unknown as Provider;

const tools = [
  { function: { name: "alpha", description: "a", parameters: { type: "object", properties: {} } } },
  { function: { name: "beta", description: "b", parameters: { type: "object", properties: {} } } },
];

function userMsg(text: string): ApiMessage {
  return { role: "user", content: text };
}

function assistantMsg(text: string): ApiMessage {
  return { role: "assistant", content: text };
}

function toolMsg(id: string): ApiMessage {
  return { role: "tool", tool_call_id: id, content: "result" };
}

function cacheMarks(blocks: any[]): any[] {
  return blocks.map((block) => block.cache_control ?? null);
}

describe("claudeCacheControlEphemeral", () => {
  test("5m 是 API 默认值,不发 ttl;1h 显式发", () => {
    expect(claudeCacheControlEphemeral(cachingOn)).toEqual({ type: "ephemeral" });
    expect(claudeCacheControlEphemeral(cachingOn1h)).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("promptCaching=false", () => {
  test("system/tools/messages 任何位置都不出现 cache_control", () => {
    const system = claudeSystemContent("sys", cachingOff) as any[];
    expect(cacheMarks(system)).toEqual([null]);
    const toolList = claudeToolsFromOpenAiTools(tools, cachingOff) as any[];
    expect(cacheMarks(toolList)).toEqual([null, null]);
    const messages = claudeMessagesFromApiMessages(
      [userMsg("q1"), assistantMsg("a1"), userMsg("q2")],
      cachingOff,
    );
    for (const message of messages) {
      expect(cacheMarks(message.content)).toEqual(message.content.map(() => null));
    }
  });
});

describe("promptCaching=true", () => {
  test("system 末块与 tools 末项带 ephemeral 且默认无 ttl", () => {
    const system = claudeSystemContent("sys", cachingOn) as any[];
    expect(system[system.length - 1].cache_control).toEqual({ type: "ephemeral" });
    const toolList = claudeToolsFromOpenAiTools(tools, cachingOn) as any[];
    expect(cacheMarks(toolList)).toEqual([null, { type: "ephemeral" }]);
  });

  test("无 system prompt 时返回 undefined,tools 断点不受影响", () => {
    expect(claudeSystemContent("", cachingOn)).toBeUndefined();
    expect(claudeSystemContent("   ", cachingOn)).toBeUndefined();
    const toolList = claudeToolsFromOpenAiTools(tools, cachingOn) as any[];
    expect(toolList[toolList.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("TTL 1h 时三类断点都带 ttl", () => {
    const system = claudeSystemContent("sys", cachingOn1h) as any[];
    expect(system[system.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const toolList = claudeToolsFromOpenAiTools(tools, cachingOn1h) as any[];
    expect(toolList[toolList.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const messages = claudeMessagesFromApiMessages(
      [userMsg("q1"), assistantMsg("a1"), userMsg("q2")],
      cachingOn1h,
    );
    const first = messages[0];
    expect(first.content[first.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  test("断点落在倒数第二条真实 user 消息的末块,最后一条不打", () => {
    const messages = claudeMessagesFromApiMessages(
      [userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2"), userMsg("q3")],
      cachingOn,
    );
    const userIndices = messages
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0);
    expect(userIndices.length).toBe(3);
    const target = messages[userIndices[1]];
    expect(target.content[target.content.length - 1].cache_control).toEqual({ type: "ephemeral" });
    for (const idx of [userIndices[0], userIndices[2]]) {
      expect(cacheMarks(messages[idx].content)).toEqual(messages[idx].content.map(() => null));
    }
  });

  test("历史图片在缓存断点投影后仍是 Claude image block", () => {
    const imageData = "AQID";
    const imageMessage: ApiMessage = {
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${imageData}` },
      }],
    };
    const messages = claudeMessagesFromApiMessages(
      [imageMessage, assistantMsg("a1"), userMsg("q2")],
      cachingOn,
    );
    const cachedImage = messages[0].content[0];

    expect(cachedImage).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imageData },
      cache_control: { type: "ephemeral" },
    });

    const uncachedImage = claudeMessagesFromApiMessages(
      [imageMessage, assistantMsg("a1"), userMsg("q2")],
      cachingOff,
    )[0].content[0];
    expect(uncachedImage).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imageData },
    });
  });

  test("只有一条真实 user 消息时 messages 里不打任何断点", () => {
    const messages = claudeMessagesFromApiMessages([userMsg("q1")], cachingOn);
    expect(cacheMarks(messages[0].content)).toEqual([null]);
  });

  test("tool_result 消息不算真实 user 消息(不吃断点也不参与计数)", () => {
    // q1 -> assistant(带工具轮) -> tool_result -> q2:真实 user 只有 q1/q2,断点应在 q1
    const messages = claudeMessagesFromApiMessages(
      [userMsg("q1"), assistantMsg("a1"), toolMsg("call_1"), userMsg("q2")],
      cachingOn,
    );
    const toolResultMsg = messages.find(
      (m) => m.role === "user" && m.content.some((b: any) => b.type === "tool_result"),
    )!;
    expect(cacheMarks(toolResultMsg.content)).toEqual(toolResultMsg.content.map(() => null));
    const q1 = messages[0];
    expect(q1.content[q1.content.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });
});
