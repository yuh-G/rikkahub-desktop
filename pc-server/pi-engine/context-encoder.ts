// pi-engine/context-encoder.ts — DB 会话历史 → pi 引擎上下文灌注(P7 会话数据统一)
//
// 定位:SQLite 是两种模式共用的唯一事实源。每轮把"UI 可见的选中路径历史"经
// message-enrichment 富化(模板/提醒/注入/截断)后,确定性重建为 pi 引擎消息,
// 灌入 SessionManager.inMemory(),由 createAgentSession 在构造点消费
// (sdk.ts:188 buildSessionContext,与 jsonl 恢复走同一内部路径)。UI 编辑/重生成/
// fork 从此真正改写引擎记忆——所见即所记,双表征的"引擎只追加、UI 可截断"容忍
// 分叉消失。
//
// 富化与保真的接缝(P8/P9):模板渲染会改变文本长度,fidelity 注解的 len 按原始 parts
// 记录——takeText 的 charOffset + len > full.length 判定会让整行自动退化 legacy,
// 剥 thinking 后重放。这是设计内行为(编辑即退化),不是缺陷。P9 起合成消息(提醒/
// 注入)随富化全序列灌进本编码器(orchestrator 把 EnrichResult.messages 整列传入,
// syntheticIds 标出合成行):它们只有 USER/ASSISTANT 两种 role,现有路径全覆盖
// (USER→encodeUser,ASSISTANT 无注解→legacy),零特判;但 synthetic 行不进
// entryIdsByMessageId(压缩切点反查按 DB 消息 id 说话)也不进 degradedMessageIds
// (legacy 是合成行唯一可走的路径,非"用户编辑过")。合成行恒在压缩切点之后——
// 富化层的 windowStartMessageId 窗口锚保证(orchestrator 以 effectiveEngineCompaction
// 的切点为锚),永不进被 appendCompaction 摘要吸收的旧历史。
//
// 确定性=缓存稳定性(§4.8 硬约束):同一历史两次编码逐字节一致(单测锁定)。所有输入
// 均来自行级数据(parts/annotations/createdAt/modelId),不掺时钟与随机数;附件文本化
// 复用生成入口同一母本(piPromptInputFromParts→contentPartsForApi,OCR 在 part
// metadata,函数纯)。模型切换会改历史用户消息的图片降级口径→前缀变化=一次性破缓存,
// 与聊天引擎同语义,接受。
//
// 保真来源(P7 桥捕获,annotations["pi-fidelity"]):
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
//   openAiToolOutput(entries) 单 text 再计算(general-tools.ts toGeneralPiToolResult
//   同源;format.ts openAiToolOutput 对已存单 text 幂等);
// - 逐字通道(工作区工具)→ text 原样 / data: 图解回 ImageContent(字节无损);
//   "空 text 仅携 metadata"载体条目跳过(桥无 text 条目时补的 metadata 挂载点);
// - 工具卡无输出无错误(中断残留)→ 合成 isError 占位,保证 toolCall/toolResult 配对
//   (provider 拒绝无结果的调用)。

import type { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { JsonValue, Message, MessagePart, Model, ToolOutputEntry } from "../foundation/types";
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
import { isRecord } from "../foundation/utils";
import { UNRESOLVED_TOOL_RESULT_TEXT, openAiToolOutput } from "../tools/format";
import { parseDataUrl } from "../inference-engine/message-builder";
import { piPromptInputFromParts } from "./attachments";

// ----- 保真注解读取 -----

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
 *  (provider 通例:toolCall 恒收尾 assistant 消息)。 */
function decodeLegacy(message: Message, fallbackModel: Model): PiAgentMessage[] {
  const timestamp = timestampOf(message);
  const groups: Array<{ texts: string[]; toolParts: ToolPartView[] }> = [];
  let current = { texts: [] as string[], toolParts: [] as ToolPartView[] };
  let sawTool = false;
  for (const part of message.parts) {
    if (!isRecord(part)) continue;
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
      model: message.modelId ?? fallbackModel.modelId,
      usage: zeroUsage(),
      stopReason: group.toolParts.length ? "toolUse" : "stop",
      timestamp,
    });
    for (const toolPart of group.toolParts) out.push(toolResultOf(toolPart, timestamp));
  }
  return out;
}

// ----- 用户行 -----

function encodeUser(message: Message, model: Model): UserMessage | null {
  const input = piPromptInputFromParts(message.parts, model);
  if (!input.text && !input.images.length) return null; // 与生成入口同一拒发条件
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: input.text }];
  content.push(...input.images);
  // 形状逐字复刻 agent-session.ts:1207-1215 的 prompt 装配(text 块恒在首位,图片后置)
  return { role: "user", content, timestamp: timestampOf(message) };
}

// ----- 行级可编码性判定(窗口锚与压缩重放共用的单源谓词) -----

/** 该行能否编出 ≥1 个条目(与编码循环同源判定)。effectiveEngineCompaction 用它把
 *  "切点落在零条目行"的压缩记录判为不适用,与编码器内部重放过滤行为一致。 */
function encodesToEntries(message: Message, model: Model): boolean {
  if (message.role === "USER") {
    const input = piPromptInputFromParts(message.parts, model);
    return Boolean(input.text) || input.images.length > 0;
  }
  if (message.role === "ASSISTANT") {
    return message.parts.some((part) =>
      isRecord(part) && (part.type === "text" || part.type === "tool"),
    );
  }
  return false; // SYSTEM 行不进引擎上下文
}

// ----- 主入口 -----

/** DB 压缩记录(conversation 级 engineCompactions 元素)。压缩记录是引擎中性的会话级
 *  状态(T3 泛化:压缩是引擎无关能力,任何 run-and-suspend 引擎都可压缩,结构不再绑死
 *  pi)。 */
export interface EngineCompactionRecord {
  /** 切点:从这条消息(含)起保留原文,之前的历史被 summary 取代。 */
  cutMessageId: string;
  summary: string;
  tokensBefore: number;
  createdAt?: string;
}

export interface PiHistoryEncodeResult {
  /** DB messageId → 灌注生成的 pi entry id 列表(压缩切点映射用;合成行不在内)。 */
  entryIdsByMessageId: Map<string, string[]>;
  /** 走了 legacy 退化的 assistant 行(诊断/测试;合成行不在内——legacy 是其设计路径)。 */
  degradedMessageIds: string[];
}

/** 把选中路径历史灌注进(空的)inMemory SessionManager。history 是富化全序列
 *  (P9:含合成行——提醒/注入,syntheticIds 标出),不含本轮新用户输入(那条走
 *  session.prompt);compactions 只取"切点仍在历史中"的最新一条生效(pi
 *  buildContextEntries 只认最后一条 compaction,更早的被覆盖)。合成行照常编码
 *  但跳过两个登记(见头注)。 */
export function seedPiSessionFromHistory(options: {
  manager: SessionManager;
  history: Message[];
  model: Model;
  /** 富化层 EnrichResult.syntheticIds(P9):标记合成行,挡在切点映射与退化诊断外。 */
  syntheticIds?: Set<string>;
  compactions?: EngineCompactionRecord[];
}): PiHistoryEncodeResult {
  const { manager, history, model } = options;
  const syntheticIds = options.syntheticIds ?? new Set<string>();
  const entryIdsByMessageId = new Map<string, string[]>();
  const degradedMessageIds: string[] = [];
  let firstSeededEntryId: string | null = null;

  for (const message of history) {
    const synthetic = syntheticIds.has(message.id);
    const entryIds: string[] = [];
    if (message.role === "USER") {
      const encoded = encodeUser(message, model);
      if (encoded) entryIds.push(manager.appendMessage(encoded));
    } else if (message.role === "ASSISTANT") {
      const fidelity = fidelityOf(message);
      let decoded = fidelity ? decodeWithFidelity(message, fidelity) : null;
      if (!decoded) {
        decoded = decodeLegacy(message, model);
        // 合成行不进退化名单:无注解走 legacy 是它唯一可走的路径(设计内),非编辑痕迹。
        if (decoded.length && !synthetic) degradedMessageIds.push(message.id);
      }
      for (const piMessage of decoded) entryIds.push(manager.appendMessage(piMessage));
    }
    // SYSTEM 行不进引擎上下文:工作区会话的 system 面由 resources(系统提示词/appendSystemPrompt)全权承载
    // 合成行不进切点映射:id 非 DB id,压缩切点若经外收拢落上来,反查 miss 由
    // captureRoundCompactions 的 null 路径兜底(orchestrator 按尾消息收拢,现有语义)。
    if (entryIds.length) {
      if (firstSeededEntryId === null) firstSeededEntryId = entryIds[0];
      if (!synthetic) entryIdsByMessageId.set(message.id, entryIds);
    }
  }

  // 压缩:取切点仍在场的最新记录。firstKept 指向"切点行之前、不可吸收的开头段"
  // 之后的第一个 entry,而非恒等于序列首 entry:
  // - 生产路径(P9):富化窗口锚(windowStartMessageId)已把切点前的真实历史挡在
  //   序列外,窗口内排在切点行之前的只可能是 top_of_chat 注入/首条时间提醒(都插
  //   在窗口首条 USER 之前)——它们是配置快照,必须留在可见区;直接按切点行算
  //   firstKept 会把它们盖进摘要区。故生产序列的首个 entry 就是正确的 firstKept。
  // - 无窗口锚的直灌调用(本文件单测/潜在测试场景):切点前的真实历史在序列里,
  //   它们理应被摘要吸收——firstKept 取切点行的首 entry,维持既有语义。
  const applicable = (options.compactions ?? [])
    .filter((record) => entryIdsByMessageId.has(record.cutMessageId))
    .at(-1);
  if (applicable) {
    const cutEntryIds = entryIdsByMessageId.get(applicable.cutMessageId)!;
    const summaryBoundary = syntheticIds.size
      ? firstSeededEntryId
      : cutEntryIds[0];
    manager.appendCompaction(applicable.summary, summaryBoundary ?? cutEntryIds[0]!, applicable.tokensBefore);
  }

  return { entryIdsByMessageId, degradedMessageIds };
}

/** 有效压缩切点判定(P9 单源):富化层取窗口锚(windowStartMessageId)前调用。
 *  与编码器内部重放过滤同一谓词(该行能否编出 ≥1 条目),切点落在空行/被删消息/
 *  零条目行上的记录一律视为不生效——取最新一条切点在场的记录,无则 null。 */
export function effectiveEngineCompaction(
  compactions: EngineCompactionRecord[],
  history: Message[],
  model: Model,
): EngineCompactionRecord | null {
  return (
    compactions
      .filter((record) => {
        const cut = history.find((msg) => msg.id === record.cutMessageId);
        return cut !== undefined && encodesToEntries(cut, model);
      })
      .at(-1) ?? null
  );
}
