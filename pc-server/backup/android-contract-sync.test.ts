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
//
// 安卓判别符全集的「单一事实源」在 foundation/types/android-contract.ts(导出降级层与
// 本测试共享同一份);本文件负责强制分类 + 仓库在场时的腐化核对。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PC_MESSAGE_ANNOTATION_TYPES } from "../foundation/types/dto";
import { PC_MESSAGE_PART_TYPES } from "../foundation/types/parts";
import { PC_KNOWN_ASR_TYPES } from "../foundation/types";
import {
  ANDROID_ANNOTATION_TYPES,
  ANDROID_ASR_PROVIDER_TYPES,
  ANDROID_MESSAGE_PART_TYPES,
  ANDROID_SEARCH_SERVICE_TYPES,
  ANDROID_TTS_PROVIDER_TYPES,
} from "../foundation/types/android-contract";
import { TTS_PROVIDER_TYPES } from "../media/tts-providers/registry";
import {
  PC_ONLY_ANNOTATION_TYPES,
  PC_ONLY_MESSAGE_PART_TYPES,
  PC_ONLY_SEARCH_SERVICE_TYPES,
} from "./export";

const repoRoot = join(import.meta.dir, "..", "..");

/** 强制二选一分类:每个 PC 判别符必须是「安卓已知」或「PC-only 黑名单」之一;
 *  且黑名单 ∩ 安卓全集 = ∅(黑名单里出现安卓合法类型 = 静默丢数据,custom_js 事故)。 */
function classify(label: string, pcTypes: readonly string[], androidKnown: ReadonlySet<string>, pcOnly: ReadonlySet<string>) {
  for (const type of pcTypes) {
    expect(
      androidKnown.has(type) || pcOnly.has(type),
      `${label} "${type}" 未分类:要么它是安卓已知类型(更新 foundation/types/android-contract.ts 的 vendored 全集),要么是 PC-only(登记进导出过滤黑名单)。二选一,不许不选。`,
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

  // C2:TTS/ASR provider 类型此前裸奔(无任何哨兵)。TTS 单源 = 注册表;ASR 单源 =
  // PC_KNOWN_ASR_TYPES。两者都必须是安卓已知(PC 不产出 APP 不认识的语音类型)。
  // ASR 方向是「PC ⊆ APP」(缺 mimo/step),故 PC-only 黑名单为空集。
  test("TTS provider:注册表全员为安卓已知", () => {
    classify("TTS provider", TTS_PROVIDER_TYPES, ANDROID_TTS_PROVIDER_TYPES, new Set());
  });

  test("ASR provider:本端类型全员为安卓已知(PC 是 APP 子集)", () => {
    classify("ASR provider", PC_KNOWN_ASR_TYPES, ANDROID_ASR_PROVIDER_TYPES, new Set());
  });
});

// ── 安卓仓库在场时:vendored 全集直接与 Kotlin 源码比对 ─────────────────────
// C1:参考仓实际位于 <项目根>/Reference-project/Rikkahub-Android(此前误写 <根>/Rikkahub-Android,
// 导致 androidRepoPresent 恒 false、本层常年沉睡,vendored 漏了 server_tool 都无人发现)。
const androidRoot = join(repoRoot, "Reference-project", "Rikkahub-Android");
const androidKt = {
  search: join(androidRoot, "search", "src", "main", "java", "me", "rerere", "search", "SearchService.kt"),
  messagePart: join(androidRoot, "ai", "src", "main", "java", "me", "rerere", "ai", "ui", "UIMessagePart.kt"),
  messageAnnotation: join(androidRoot, "ai", "src", "main", "java", "me", "rerere", "ai", "ui", "UIMessageAnnotation.kt"),
  tts: join(androidRoot, "speech", "src", "main", "java", "me", "rerere", "tts", "provider", "TTSProviderSetting.kt"),
  asr: join(androidRoot, "speech", "src", "main", "java", "me", "rerere", "asr", "ASRProviderSetting.kt"),
} as const;
const androidRepoPresent = Object.values(androidKt).every((p) => existsSync(p));

if (!androidRepoPresent) {
  // C1 修复:不再「静默 skip 当绿灯」。仓库缺席时分类层(上方 describe)照常跑,这里打一条醒目
  // 提示——「没核到」必须可见,而不是无声地让 CI 变绿。
  console.warn(
    "\n[android-contract-sync] ⚠️ 安卓参考仓缺席,跳过 vendored↔Kotlin 腐化核对" +
    `(期望路径:${androidRoot})。消息 part/注解/搜索服务/TTS/ASR 的 vendored 全集本次未与源码比对。` +
    "本机开发请保留 Reference-project/Rikkahub-Android;CI/分发环境可忽略此提示。\n",
  );
}

function serialNamesIn(text: string): string[] {
  return [...text.matchAll(/@SerialName\("([^"]+)"\)/g)].map((m) => m[1]);
}

/** 取「从 sealed class X 到 同级下一个 sealed/enum class 声明 或文件尾」的区段。用于把目标
 *  密封类的 @SerialName 与同文件里的其它枚举/密封类隔开——例:UIMessagePart.kt 同时声明了
 *  ToolApprovalState(auto/pending/…)、ServerToolStatus、ReasoningType;SearchService.kt 尾部还有
 *  DoubaoSearchMode(global/custom)。不隔开会把这些误判成消息 part / 搜索服务判别符。 */
function sealedBodyOf(text: string, sealedDecl: string): string {
  const start = text.indexOf(sealedDecl);
  if (start < 0) throw new Error(`Kotlin 源码结构变化:找不到声明「${sealedDecl}」`);
  const rest = text.slice(start + sealedDecl.length);
  const next = rest.search(/\n\s*(?:@\w+(?:\([^)]*\))?\s*\n\s*)*(?:sealed|enum)\s+class\s/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe.skipIf(!androidRepoPresent)("vendored 全集与安卓源码一致(仓库在场时自动核对)", () => {
  test("SearchServiceOptions 判别符全集", () => {
    const fromSource = serialNamesIn(sealedBodyOf(readFileSync(androidKt.search, "utf8"), "sealed class SearchServiceOptions"));
    expect(fromSource.length).toBeGreaterThanOrEqual(15);
    expect(new Set(fromSource)).toEqual(new Set(ANDROID_SEARCH_SERVICE_TYPES));
  });

  test("UIMessagePart 判别符全集(含 server_tool)", () => {
    const partNames = serialNamesIn(sealedBodyOf(readFileSync(androidKt.messagePart, "utf8"), "sealed class UIMessagePart"));
    expect(partNames.length).toBeGreaterThanOrEqual(8);
    expect(new Set(partNames)).toEqual(new Set(ANDROID_MESSAGE_PART_TYPES));
  });

  test("UIMessageAnnotation 判别符全集", () => {
    const annotationNames = serialNamesIn(sealedBodyOf(readFileSync(androidKt.messageAnnotation, "utf8"), "sealed class UIMessageAnnotation"));
    expect(new Set(annotationNames)).toEqual(new Set(ANDROID_ANNOTATION_TYPES));
  });

  test("TTSProviderSetting 判别符全集(C2)", () => {
    const fromSource = serialNamesIn(sealedBodyOf(readFileSync(androidKt.tts, "utf8"), "sealed class TTSProviderSetting"));
    expect(fromSource.length).toBeGreaterThanOrEqual(12);
    expect(new Set(fromSource)).toEqual(new Set(ANDROID_TTS_PROVIDER_TYPES));
  });

  test("ASRProviderSetting 判别符全集(C2)", () => {
    const fromSource = serialNamesIn(sealedBodyOf(readFileSync(androidKt.asr, "utf8"), "sealed class ASRProviderSetting"));
    expect(fromSource.length).toBeGreaterThanOrEqual(5);
    expect(new Set(fromSource)).toEqual(new Set(ANDROID_ASR_PROVIDER_TYPES));
  });
});
