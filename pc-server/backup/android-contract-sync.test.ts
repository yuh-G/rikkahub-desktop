// 专题3 批4:PC↔APP 契约机械化核对。
//
// 动机(两起真实事故):
// ① custom_js 曾被误判为 PC-only 并在导出时过滤——其实它是安卓正式类型(人工核对看错
//   了模块,me.rerere.search.SearchService.kt 才是 Settings 引用的那个);
// ② PC 的 loading 占位 part 从未被过滤,崩溃残留导出到安卓 = 会话打不开。
// 结论:兼容性判定不能靠"开发新功能时惦记着"。本文件把它变成机械:
//   - PC 侧判别符全集来自类型注册表(PC_MESSAGE_*_TYPES,联合类型新增成员不登记则编译
//     失败)与 web-ui 可创建服务清单(直接从源码提取);
//   - 每个 PC 判别符必须被显式分类:安卓已知(vendored 全集)或 PC-only(导出过滤黑名单);
//   - 黑名单与安卓全集必须不相交(正是事故①:黑名单里出现安卓合法类型 = 静默丢数据);
//   - 本机存在安卓仓库时,vendored 全集直接与 Kotlin 源码里的 @SerialName 比对,过期即红。
// 任何一条红了,都说明有人改了契约面而没有做出兼容性决定。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PC_MESSAGE_ANNOTATION_TYPES } from "../foundation/types/dto";
import { PC_MESSAGE_PART_TYPES } from "../foundation/types/parts";
import {
  PC_ONLY_ANNOTATION_TYPES,
  PC_ONLY_MESSAGE_PART_TYPES,
  PC_ONLY_SEARCH_SERVICE_TYPES,
} from "./export";

const repoRoot = join(import.meta.dir, "..", "..");

// ── vendored 安卓判别符全集 ─────────────────────────────────────────────────
// 来源(2026-07-28 同步):
// - 搜索服务:Rikkahub-Android/search/src/main/java/me/rerere/search/SearchService.kt
//   sealed class SearchServiceOptions 的全部 @SerialName。
// - 消息 part / 注解:Rikkahub-Android/ai/src/main/java/me/rerere/ai/ui/Message.kt
//   sealed class UIMessagePart / UIMessageAnnotation 的全部 @SerialName。
// 安卓仓库在本机时,下方 "vendored 全集与安卓源码一致" 测试会自动核对这些清单。
const ANDROID_SEARCH_SERVICE_TYPES = new Set([
  "bing_local", "zhipu", "tavily", "exa", "searxng", "linkup", "brave", "metaso", "ollama",
  "perplexity", "firecrawl", "jina", "bocha", "rikkahub", "grok", "tinyfish", "serper", "custom_js",
  "doubao",
]);
const ANDROID_MESSAGE_PART_TYPES = new Set([
  "text", "image", "video", "audio", "document", "reasoning", "search", "tool_call", "tool_result", "tool",
]);
const ANDROID_ANNOTATION_TYPES = new Set(["url_citation"]);

function classify(label: string, pcTypes: readonly string[], androidKnown: Set<string>, pcOnly: ReadonlySet<string>) {
  for (const type of pcTypes) {
    expect(
      androidKnown.has(type) || pcOnly.has(type),
      `${label} "${type}" 未分类:要么它是安卓已知类型(更新本文件 vendored 全集),要么是 PC-only(登记进导出过滤黑名单)。二选一,不许不选。`,
    ).toBe(true);
  }
  for (const type of pcOnly) {
    expect(
      androidKnown.has(type),
      `${label} 黑名单里的 "${type}" 其实是安卓已知类型——过滤它 = 静默丢用户数据(custom_js 事故重演)。`,
    ).toBe(false);
  }
}

describe("PC 判别符 → 安卓兼容性分类(强制二选一)", () => {
  test("消息注解:注册表全员已分类,黑名单与安卓全集不相交", () => {
    classify("注解", PC_MESSAGE_ANNOTATION_TYPES, ANDROID_ANNOTATION_TYPES, PC_ONLY_ANNOTATION_TYPES);
  });

  test("消息 part:注册表全员已分类,黑名单与安卓全集不相交", () => {
    classify("part", PC_MESSAGE_PART_TYPES, ANDROID_MESSAGE_PART_TYPES, PC_ONLY_MESSAGE_PART_TYPES);
  });

  test("搜索服务:web-ui 可创建类型全员已分类,黑名单与安卓全集不相交", () => {
    // PC 用户能配出什么,以前端"添加服务"的类型清单为准(settings 里出现的其余类型只能
    // 来自安卓导入,天然安卓兼容)。直接从源码提取,前端加类型不改这里就会红。
    const source = readFileSync(join(repoRoot, "web-ui", "app", "components", "settings", "search.tsx"), "utf8");
    const arrayMatch = source.match(/\[\s*((?:"[a-z0-9_]+"\s*,\s*)+"[a-z0-9_]+"\s*,?\s*)\]\s*as const/);
    expect(arrayMatch, "web-ui search.tsx 里的服务类型 as const 数组未找到(重构了?同步更新本测试的提取逻辑)").toBeTruthy();
    const creatable = [...arrayMatch![1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(creatable.length).toBeGreaterThanOrEqual(10);
    classify("搜索服务", creatable, ANDROID_SEARCH_SERVICE_TYPES, PC_ONLY_SEARCH_SERVICE_TYPES);
  });
});

// ── 安卓仓库在场时:vendored 全集直接与 Kotlin 源码比对 ─────────────────────
const androidSearchKt = join(repoRoot, "Rikkahub-Android", "search", "src", "main", "java", "me", "rerere", "search", "SearchService.kt");
const androidMessageKt = join(repoRoot, "Rikkahub-Android", "ai", "src", "main", "java", "me", "rerere", "ai", "ui", "Message.kt");
const androidRepoPresent = existsSync(androidSearchKt) && existsSync(androidMessageKt);

function serialNamesIn(text: string): string[] {
  return [...text.matchAll(/@SerialName\("([^"]+)"\)/g)].map((m) => m[1]);
}

function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error(`Kotlin 源码结构变化:找不到 ${startMarker} … ${endMarker} 区段`);
  return text.slice(start, end);
}

describe.skipIf(!androidRepoPresent)("vendored 全集与安卓源码一致(仓库在场时自动核对)", () => {
  test("SearchServiceOptions 判别符全集", () => {
    const fromSource = serialNamesIn(readFileSync(androidSearchKt, "utf8"));
    expect(fromSource.length).toBeGreaterThanOrEqual(15);
    expect(new Set(fromSource)).toEqual(ANDROID_SEARCH_SERVICE_TYPES);
  });

  test("UIMessagePart / UIMessageAnnotation 判别符全集", () => {
    const source = readFileSync(androidMessageKt, "utf8");
    const partNames = serialNamesIn(sliceBetween(source, "sealed class UIMessagePart", "sealed class UIMessageAnnotation"));
    expect(partNames.length).toBeGreaterThanOrEqual(8);
    expect(new Set(partNames)).toEqual(ANDROID_MESSAGE_PART_TYPES);
    const annotationNames = serialNamesIn(sliceBetween(source, "sealed class UIMessageAnnotation", "data class MessageChunk"));
    expect(new Set(annotationNames)).toEqual(ANDROID_ANNOTATION_TYPES);
  });
});
