// pi-engine/context-encoder.ts — 中立消息 → pi 引擎消息(会话视图的回退编码)
//
// 会话视图(pi-engine/session-view)里没有可用原生条目的行由本模块从中立内容编码:用户行与
// 合成行恒走这里;助手行在原生条目缺失或作废(编辑过、别的引擎生成、老数据、生成中崩溃未封存)
// 时走这里。SQLite 的中立记录是两种引擎共用的事实源,UI 编辑/重生成/fork 改写的就是它,
// 回退编码让这些改动真正改写引擎记忆。
//
// 富化与保真的接缝(P8/P9):模板渲染会改变文本长度,fidelity 注解的 len 按原始 parts
// 记录——takeText 的 charOffset + len > full.length 判定会让整行自动退化 legacy,
// 剥 thinking 后重放。这是设计内行为(编辑即退化),不是缺陷。合成消息(提醒/注入)只有
// USER/ASSISTANT 两种 role,现有路径全覆盖(USER→encodeUser,ASSISTANT 无注解→legacy),零特判。
//
// 确定性=缓存稳定性(§4.8 硬约束):同一历史两次编码逐字节一致(单测锁定)。所有输入
// 均来自行级数据(parts/annotations/createdAt/modelId),不掺时钟与随机数。USER 行的
// 模型可见输入由应用侧预先物化(契约 EngineSessionItem.input,promptInputFromParts→
// contentPartsForApi,与生成入口同一母本),本编码器不读应用的文件表。模型切换会改历史
// 用户消息的图片降级口径→前缀变化=一次性破缓存,与聊天引擎同语义,接受。
//
// [LEGACY-READ: pi-fidelity] 保真来源(P7 桥捕获,annotations["pi-fidelity"];P3.4 起不再写入,
// 新轮次的块结构与签名在引擎私有条目里,有效时由 session-view 原样取用。老数据可能长期存在,
// 读取不设拆除期限):
// - 引擎消息分组:msg 序号数组,每条 = 块序列(parts 是合并视图——连续同类增量并入
//   同一 part,且跨引擎消息的相邻同类文本也会并入;块 len 把合并文本按字符游标切回原块);
// - 思维链签名:sig/redacted 逐块回填(Anthropic 签名/redacted 加密载荷,跨轮重放必需);
// - api/provider/model:AssistantMessage 必填元数据,用捕获值而非占位符。
// 自校验退化:块与 part 对不上(用户编辑过历史/存量 P2-P6 行无注解)→ 该行走 legacy
// 路径——剥 thinking(编辑即签名失效,剥净是唯一合法重放)+ 启发式分组(连续 tool part
// 段结束遇非 tool part 即断消息),一次性缓存冷,UI 历史零损失。
//
// 工具结果反向(与捕获侧一一对应,event-bridge.ts mapPiToolResult 的逆):
// - {error} 载荷 → isError:true + 单 text(桥存的就是 pi 错误 content 原文);
// - app 通道(首条目 metadata.pi.src==="app",通用工具实体化产物)→ content =
//   openAiToolOutput(entries) 单 text 再计算(engines/app-tools.ts generalResult
//   同源;format.ts openAiToolOutput 对已存单 text 幂等);
// - 逐字通道(工作区工具)→ text 原样 / data: 图解回 ImageContent(字节无损);
//   "空 text 仅携 metadata"载体条目跳过(桥无 text 条目时补的 metadata 挂载点);
// - 工具卡无输出无错误(中断残留)→ 合成 isError 占位,保证 toolCall/toolResult 配对
//   (provider 拒绝无结果的调用)。

import type { PromptInput } from "../engines/contract";
import type { JsonValue, Message, MessagePart, ToolOutputEntry } from "../foundation/types";
import type {
  AssistantMessage,
  ImageContent,
  JsonObject,
  Message as PiAgentMessage,
  TextContent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../../pi/packages/ai/src/types.ts";
import { isRecord, parseDataUrl } from "../foundation/utils";
import { UNRESOLVED_TOOL_RESULT_TEXT, openAiToolOutput } from "../tools/format";

// ----- 保真注解读取 [LEGACY-READ: pi-fidelity] -----

interface FidelityBlock {
  type: string;
  len?: number;
  sig?: string;
  redacted?: boolean;
  toolCallId?: string;
}

interface FidelityAnnotation {
  api: string;
  provider: string;
  model: string;
  messages: FidelityBlock[][];
}

function fidelityOf(message: Message): FidelityAnnotation | null {
  for (const annotation of message.annotations) {
    if (!isRecord(annotation) || annotation.type !== "pi-fidelity" || !Array.isArray(annotation.messages)) continue;
    const messages: FidelityBlock[][] = [];
    for (const blocks of annotation.messages) {
      if (!Array.isArray(blocks)) return null;
      const parsed: FidelityBlock[] = [];
      for (const block of blocks) {
        if (!isRecord(block) || typeof block.type !== "string") return null;
        parsed.push({
          type: block.type,
          len: typeof block.len === "number" ? block.len : undefined,
          sig: typeof block.sig === "string" ? block.sig : undefined,
          redacted: block.redacted === true,
          toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : undefined,
        });
      }
      messages.push(parsed);
    }
    return {
      api: String(annotation.api ?? ""),
      provider: String(annotation.provider ?? ""),
      model: String(annotation.model ?? ""),
      messages,
    };
  }
  return null;
}

// ----- 工具卡 → toolCall / toolResult -----

type ToolPartView = Extract<MessagePart, { type: "tool" }>;

// pi 1.0.3 起 ToolCall.arguments 是 JsonObject(值域 JsonValue,非 unknown)。工具卡
// input 的 JSON.parse 产物经 isRecord 守卫已是同构 record,这里只补静态收窄;解析失败
// 或非对象落空对象——与 pi 空参调用 arguments:{} 逐字一致。
function parseToolArguments(input: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(input || "{}");
    return isRecord(parsed) ? (parsed as unknown as JsonObject) : {};
  } catch {
    // 解析失败的兜底:空参重放(与下方 isRecord=false 同道),工具身份仍可配对。
    return {};
  }
}

function errorTextOf(output: ToolOutputEntry[]): string | null {
  for (const entry of output) {
    if (!isRecord(entry)) continue;
    const error = (entry as Record<string, unknown>).error;
    if (typeof error === "string") return error;
  }
  return null;
}

function isAppChannel(output: ToolOutputEntry[]): boolean {
  const first = output[0];
  return (
    isRecord(first) &&
    isRecord(first.metadata) &&
    isRecord(first.metadata.pi) &&
    (first.metadata.pi as Record<string, JsonValue>).src === "app"
  );
}

/** 逐字通道:桥 mapPiToolContent 的逆——text 原样、data: 图解回字节。 */
function verbatimContent(output: ToolOutputEntry[]): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  for (const entry of output) {
    if (!isRecord(entry)) continue;
    if (entry.type === "text") {
      const text = String(entry.text ?? "");
      if (!text && entry.metadata) continue; // 空 text 载体条目(桥的 metadata 挂载点)
      content.push({ type: "text", text });
      continue;
    }
    if (entry.type === "image") {
      const url = String(entry.url ?? "");
      const parsed = parseDataUrl(url);
      // 逐字通道图片恒为 data:(mapPiToolContent 产物);非 data 视为异常存档,占位降级。
      if (parsed) content.push({ type: "image", data: parsed.data, mimeType: parsed.mime });
      else if (url) content.push({ type: "text", text: `[Image: ${url}]` });
    }
  }
  return content;
}

function toolResultOf(part: ToolPartView, timestamp: number): ToolResultMessage {
  const output = Array.isArray(part.output) ? part.output : [];
  const errorText = errorTextOf(output);
  if (errorText !== null) {
    return {
      role: "toolResult",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      content: [{ type: "text", text: errorText }],
      isError: true,
      timestamp,
    };
  }
  if (!output.length) {
    // 中断残留:有调用无结果。合成确定性占位保证配对(与 pi 中断轮自身的补录语义等价)。
    // 文案常量与聊天引擎的 toolResultTextForApi 同源——两引擎回灌模型的表述必须一致。
    return {
      role: "toolResult",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      content: [{ type: "text", text: UNRESOLVED_TOOL_RESULT_TEXT }],
      isError: true,
      timestamp,
    };
  }
  const content = isAppChannel(output)
    ? [{ type: "text", text: openAiToolOutput(output) } satisfies TextContent]
    : verbatimContent(output);
  return {
    role: "toolResult",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    content,
    isError: false,
    timestamp,
  };
}

// ----- assistant 行 → 引擎消息序列 -----

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function timestampOf(message: Message): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 保真解码:块序列驱动字符游标切分合并 parts。任何不吻合(编辑过/结构漂移)返回 null
 *  交给 legacy。游标设计天然处理"跨引擎消息的文本并入同一 part"(len 精确切割)。 */
function decodeWithFidelity(message: Message, fidelity: FidelityAnnotation): PiAgentMessage[] | null {
  const parts = message.parts.filter(
    (part): part is MessagePart => isRecord(part) && (part.type === "reasoning" || part.type === "text" || part.type === "tool"),
  );
  let partIndex = 0;
  let charOffset = 0;

  const takeText = (kind: "reasoning" | "text", len: number): string | null => {
    if (len === 0) return ""; // redacted/空块不消耗 part(redacted 思维链无增量,无对应 part)
    while (partIndex < parts.length) {
      const part = parts[partIndex]!;
      if (part.type !== kind) return null;
      const full = kind === "reasoning" ? String((part as { reasoning: string }).reasoning ?? "") : String((part as { text: string }).text ?? "");
      if (charOffset >= full.length && full.length > 0 && charOffset > 0) {
        partIndex += 1;
        charOffset = 0;
        continue;
      }
      if (charOffset + len > full.length) return null;
      const slice = full.slice(charOffset, charOffset + len);
      charOffset += len;
      if (charOffset >= full.length) {
        partIndex += 1;
        charOffset = 0;
      }
      return slice;
    }
    return null;
  };

  const takeTool = (toolCallId: string | undefined): ToolPartView | null => {
    if (partIndex >= parts.length || charOffset !== 0) return null;
    const part = parts[partIndex]!;
    if (part.type !== "tool" || !toolCallId || part.toolCallId !== toolCallId) return null;
    partIndex += 1;
    return part;
  };

  const timestamp = timestampOf(message);
  const out: PiAgentMessage[] = [];
  for (const blocks of fidelity.messages) {
    const content: AssistantMessage["content"] = [];
    const toolParts: ToolPartView[] = [];
    for (const block of blocks) {
      if (block.type === "thinking") {
        const thinking = takeText("reasoning", block.len ?? 0);
        if (thinking === null) return null;
        content.push({
          type: "thinking",
          thinking,
          ...(block.sig ? { thinkingSignature: block.sig } : {}),
          ...(block.redacted ? { redacted: true } : {}),
        });
      } else if (block.type === "text") {
        const text = takeText("text", block.len ?? 0);
        if (text === null) return null;
        content.push({ type: "text", text });
      } else if (block.type === "toolCall") {
        const toolPart = takeTool(block.toolCallId);
        if (!toolPart) return null;
        content.push({
          type: "toolCall",
          id: toolPart.toolCallId,
          name: toolPart.toolName,
          arguments: parseToolArguments(toolPart.input),
        });
        toolParts.push(toolPart);
      } else {
        return null; // 未知块类型:注解来自更新版本,宁可退化不猜
      }
    }
    out.push({
      role: "assistant",
      content,
      api: fidelity.api as AssistantMessage["api"],
      provider: fidelity.provider,
      model: fidelity.model,
      usage: zeroUsage(),
      stopReason: toolParts.length ? "toolUse" : "stop",
      timestamp,
    });
    for (const toolPart of toolParts) out.push(toolResultOf(toolPart, timestamp));
  }
  // 剩余未消费的实质内容 = 注解之外新增/改动过 → 整行退化
  while (partIndex < parts.length) {
    const part = parts[partIndex]!;
    if (part.type === "tool") return null;
    const full = part.type === "reasoning" ? String((part as { reasoning: string }).reasoning ?? "") : String((part as { text: string }).text ?? "");
    if (charOffset < full.length) return null;
    partIndex += 1;
    charOffset = 0;
  }
  return out;
}

/** legacy 路径:无注解(P2-P6 存量)或注解失配(编辑过)。剥 thinking(无签名不可复签,
 *  剥净是唯一合法重放),启发式分组:连续 tool part 段结束后遇到非 tool part 即断消息
 *  (provider 通例:toolCall 恒收尾 assistant 消息)。notice 片段(APP 一轮中途到达的运行时通知)在原位置
 *  断开,编成一条只带 text 的用户消息(与聊天引擎的 expandNotices 同一规则)。 */
function decodeLegacy(message: Message, fallbackModelId: string): PiAgentMessage[] {
  const timestamp = timestampOf(message);
  const groups: Array<{ texts: string[]; toolParts: ToolPartView[] } | { notice: string }> = [];
  let current = { texts: [] as string[], toolParts: [] as ToolPartView[] };
  let sawTool = false;
  for (const part of message.parts) {
    if (!isRecord(part)) continue;
    if (part.type === "notice") {
      if (current.texts.length || current.toolParts.length) groups.push(current);
      current = { texts: [], toolParts: [] };
      sawTool = false;
      groups.push({ notice: String(part.text ?? "") });
      continue;
    }
    if (part.type === "tool") {
      current.toolParts.push(part as ToolPartView);
      sawTool = true;
      continue;
    }
    if (part.type !== "text") continue; // reasoning 剥除;loading/image 等非引擎内容跳过
    const text = String((part as { text: string }).text ?? "");
    if (sawTool) {
      groups.push(current);
      current = { texts: [], toolParts: [] };
      sawTool = false;
    }
    if (text) current.texts.push(text);
  }
  if (current.texts.length || current.toolParts.length) groups.push(current);

  const out: PiAgentMessage[] = [];
  for (const group of groups) {
    if ("notice" in group) {
      if (group.notice) out.push({ role: "user", content: [{ type: "text", text: group.notice }], timestamp });
      continue;
    }
    const content: AssistantMessage["content"] = [];
    for (const text of group.texts) content.push({ type: "text", text });
    for (const toolPart of group.toolParts) {
      content.push({
        type: "toolCall",
        id: toolPart.toolCallId,
        name: toolPart.toolName,
        arguments: parseToolArguments(toolPart.input),
      });
    }
    if (!content.length) continue;
    out.push({
      role: "assistant",
      content,
      api: "openai-completions" as AssistantMessage["api"],
      provider: "unknown",
      model: message.modelId ?? fallbackModelId,
      usage: zeroUsage(),
      stopReason: group.toolParts.length ? "toolUse" : "stop",
      timestamp,
    });
    for (const toolPart of group.toolParts) out.push(toolResultOf(toolPart, timestamp));
  }
  return out;
}

// ----- 用户行 -----

/** 应用已物化的输入 → pi 用户消息。缺项 = 该行没有可发送内容(与生成入口同一拒发条件)。 */
function encodeUser(message: Message, input: PromptInput | undefined): UserMessage | null {
  if (!input || (!input.text && !input.images.length)) return null;
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: input.text }];
  content.push(...input.images);
  // 形状逐字复刻 agent-session.ts _startRun 的 prompt 装配(text 块恒在首位,图片后置)
  return { role: "user", content, timestamp: timestampOf(message) };
}

// ----- 入口 -----

/** 一条中立消息的回退编码。USER 行取应用物化的输入(缺省 = 没有可发送内容);ASSISTANT 行先按
 *  保真注解解码,无注解或失配走 legacy(degraded);SYSTEM 行不进引擎上下文——工作区会话的
 *  system 面由 resources(系统提示词/appendSystemPrompt)全权承载。 */
export function encodeNeutralMessage(
  message: Message,
  input: PromptInput | undefined,
  fallbackModelId: string,
): { messages: PiAgentMessage[]; degraded: boolean } {
  if (message.role === "USER") {
    const encoded = encodeUser(message, input);
    return { messages: encoded ? [encoded] : [], degraded: false };
  }
  if (message.role !== "ASSISTANT") return { messages: [], degraded: false };
  // 保真注解只来自桌面端自己的生成,不认识 notice;带 notice 的行一律走 legacy,免得它被静默丢掉。
  const fidelity = message.parts.some((part) => part.type === "notice") ? null : fidelityOf(message);
  const decoded = fidelity ? decodeWithFidelity(message, fidelity) : null;
  if (decoded) return { messages: decoded, degraded: false };
  const legacy = decodeLegacy(message, fallbackModelId);
  return { messages: legacy, degraded: legacy.length > 0 };
}
