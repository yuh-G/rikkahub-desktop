// pi-engine/runner.ts — pi 会话生成驱动器(P2 骨架;P7 重写为统一会话数据)
//
// 一次调用 = 我们会话模型里的一轮生成:注入模型运行时(P1 model-bridge)→ 把 SQLite
// 选中路径历史灌注进内存 SessionManager(P7 context-encoder;inMemory,零 jsonl)→
// 订阅事件经桥(event-bridge)映射为 GenerationEvent 灌进调用方 sink(生产侧即
// generateAnswer 的共享应用器)→ prompt 等待回合结束 → 按桥观察到的终局决定
// return/throw,顺手捕获本轮 pi 自动压缩产物(摘要以会话行为事实源,见下)。
//
// 契约与聊天引擎流式函数对齐:sink 语义相同、abort 经 AbortSignal、上游失败以 throw
// 上抛(generateAnswer 的失败分支统一做 reportError/失败文本/注解)。P3 把工作区会话的
// runGeneration 切到本驱动器,generateAnswer 的收尾/错误/审批框架原样复用。
//
// P7 会话数据统一(方案 §4.7):SQLite 是唯一事实源,引擎上下文每轮从选中路径历史
// 确定性重建(context-encoder 保真注解解码,失配行自校验退 legacy),不再有
// 会话↔jsonl 文件关联。pi 自动压缩发生在 prompt 内部,结果捕获为
// capturedCompactions(firstKeptEntryId 反查灌注映射回到 DB 消息 id),由调用方落
// conversation.engineCompactions——下一轮经编码器 appendCompaction 重放,语义逐字等价。
// P9 灌注统一:history 是富化全序列(含合成行,orchestrator 以压缩切点为富化窗口
// 锚),聊天位注入/时间提醒在工作区会话与聊天引擎逐字同生效。
//
// P3 工具面:noTools:"builtin"——pi 内建 read/bash/edit/write 一律不启用(它们绕开
// 我们的审批与边界壳),我们的七工具经 ctx.tools 以 customTools 注册
// (pi-engine/workspace-tools.ts,审批内化在工具 execute 里)。不传 tools 即纯对话
// (与 P2 语义等价:无任何激活工具,系统提示词 Available tools 为 "(none)")。

import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { GenerationEventSink } from "../inference-engine/events";
import type { Message, Model, Provider } from "../foundation/types";
import { piAgentDir } from "../foundation/paths";
import { CodedError } from "../foundation/errors";
import { createPiModelRuntime, mapProviderModelToPi, piThinkingLevelFor, type PiModelLimits } from "./model-bridge";
import { llmLogContextFor, runWithLlmRequestLog } from "./llm-request-log";
import { createPiEventBridge } from "./event-bridge";
import { clearToolApprovalWaiters } from "../inference-engine/approval-gate";
import type { PiSessionResources } from "./resources";
import { seedPiSessionFromHistory, type EngineCompactionRecord } from "./context-encoder";
import { sweepWorkspaceReservedNameArtifacts } from "../workspace/files";
import { reportError } from "../observability/app-errors";

export interface PiGenerationContext {
  /** 生效 provider/model(调用方经 findModel 解析,providerOverwrite 已展开)。 */
  provider: Provider;
  model: Model;
  /** 模型极限(P5:orchestrator 从 models.dev/助手配置取值;不传用 model-bridge 保守默认)。
   *  contextWindow 决定 pi 自动压缩阈值(contextWindow - reserveTokens),必须尽量真实。 */
  modelLimits?: PiModelLimits;
  /** 助手思考强度(assistant.reasoningLevel 原值;经 piThinkingLevelFor 译成 pi 档位:
   *  off→off、六档直传、auto/未知→medium)。不传=medium(纯测试/冒烟场景)。 */
  reasoningLevel?: string | null;
  /** 会话身份(审批等待者清扫的归属键;引擎上下文与身份无关,纯由 history 决定)。 */
  conversationId: string;
  /** 会话工作目录(工作区边界内的绝对路径)。 */
  cwd: string;
  /** P9:选中路径上的历史消息(富化全序列,含合成行——提醒/聊天位注入,
   *  syntheticIds 标出;不含本轮新用户输入——那条走 session.prompt)。 */
  history: Message[];
  /** P9:富化层 EnrichResult.syntheticIds,透传编码器(合成行照常编码,挡在切点
   *  映射与退化诊断外)。生产侧生成路径必传;手动压缩路径传 real-only 序列,不传。 */
  syntheticIds?: Set<string>;
  /** P7:既有压缩记录(conversation.engineCompactions 解析产物;编码器只取切点仍在
   *  历史中的最新一条生效)。 */
  compactions?: EngineCompactionRecord[];
  /** 本轮用户输入(文本;文档/OCR 已由 pi-engine/attachments 文本化)。 */
  promptText: string;
  /** 图片附件(pi 原生 prompt images 通道,P4 附件面)。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** 资源装配(P4:技能/AGENTS.md/appendSystemPrompt/受控 settings,
   *  生产侧 = createPiSessionResources;不传 = 纯对话,pi 默认资源面全关不了——
   *  仅测试/冒烟场景使用,生产路由必须传)。 */
  resources?: PiSessionResources;
  /** customTools(生产侧 = 七个工作区工具 + 通用工具/MCP 桥;不传 = 纯对话)。 */
  tools?: ToolDefinition[];
  /** 生成事件下沉(生产侧 = conversations/generation-apply 的应用器)。 */
  sink: GenerationEventSink;
  signal?: AbortSignal;
  /** steering(用户问题②,对齐 Codex pending_input):生成中补发的用户消息取流。
   *  runner 在 prompt 驱动期间轮询本回调,有新文本即调 pi 原生 session.steer()
   *  (agent-loop 在「当前轮工具执行完、下一次 LLM 调用前」排水注入——语义与
   *  Codex 逐字一致)。不传 = 无 steering 能力(消息留在 FIFO 队列收尾派发兜底)。
   *  回调由编排层实现(落库/队列联动在编排层,runner 零副作用)。 */
  pollSteering?: () => string[];
}

/** 压缩产物的 DB 侧映射(runner 返回;orchestrator 负责落 conversation.engineCompactions)。
 *  引擎中性(T3):结构与引擎无关,任何 run-and-suspend 引擎的压缩捕获都用它。 */
export interface CapturedEngineCompaction {
  /** 切点(首个保留原文的 DB 消息 id)。null = 切点落在本轮(prompt 之后)——
   *  本轮消息尚未入库,调用方按"外收拢"落为当前尾消息 id(只多保不少保,
   *  下一轮编码器按"切点在场"自校验生效)。 */
  cutMessageId: string | null;
  summary: string;
  tokensBefore: number;
}

export interface PiGenerationResult {
  /** 全程 assistant 可见文本(镜像聊天引擎 allContent 口径:trim,空则占位)。 */
  text: string;
  /** 灌注后走了 legacy 退化的 assistant 行 id(诊断;注解失配=用户编辑过历史)。 */
  degradedMessageIds: string[];
  stopReason: string | null;
  capturedCompactions: CapturedEngineCompaction[];
}

/** 本轮新增的压缩条目 → DB 压缩记录。切点反查灌注映射(assistant 行一条消息产
 *  多个 entry,任一命中即归属该消息);查不到 = 切点在本轮,交调用方外收拢。 */
function captureRoundCompactions(
  manager: SessionManager,
  seededEntryIds: Set<string>,
  entryIdsByMessageId: Map<string, string[]>,
): CapturedEngineCompaction[] {
  const captured: CapturedEngineCompaction[] = [];
  for (const entry of manager.getEntries()) {
    if (entry.type !== "compaction" || seededEntryIds.has(entry.id)) continue;
    let cutMessageId: string | null = null;
    for (const [messageId, entryIds] of entryIdsByMessageId) {
      if (entryIds.includes(entry.firstKeptEntryId)) {
        cutMessageId = messageId;
        break;
      }
    }
    captured.push({ cutMessageId, summary: entry.summary, tokensBefore: entry.tokensBefore });
  }
  return captured;
}

export async function runPiGeneration(ctx: PiGenerationContext): Promise<PiGenerationResult> {
  if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  const mapped = mapProviderModelToPi(ctx.provider, ctx.model, ctx.modelLimits, ctx.conversationId);
  if (!mapped.ok) throw new Error(`该模型无法在工作区引擎使用：${mapped.reason}`);
  const { runtime, model } = await createPiModelRuntime(mapped.mapping);

  // 问题4(2.0.0 内测):每轮生成前清扫工作区根的 Windows 保留设备名残留(nul 等)——
  // 兼作存量自愈:内测期已产生的残留在用户下次使用该工作区时自动消失。
  sweepWorkspaceReservedNameArtifacts(ctx.cwd);

  // P7:引擎上下文从 SQLite 历史每轮重建,inMemory 会话零文件生命周期。
  const manager = SessionManager.inMemory(ctx.cwd);
  const seeded = seedPiSessionFromHistory({
    manager,
    history: ctx.history,
    model: ctx.model,
    syntheticIds: ctx.syntheticIds,
    compactions: ctx.compactions,
  });
  const seededEntryIds = new Set(manager.getEntries().map((entry) => entry.id));

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: piAgentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    thinkingLevel: piThinkingLevelFor(ctx.reasoningLevel),
    // "builtin" 只关内建工具;customTools 经 includeAllExtensionTools 全部激活
    // (sdk.ts:246-251 + agent-session._refreshToolRegistry,§七-3 实证)。
    noTools: "builtin",
    customTools: ctx.tools ?? [],
    // P4 资源统一:受控 ResourceLoader(技能白名单/AGENTS.md 边界过滤/appendSystemPrompt)
    // + 受控 SettingsManager(inMemory,封死 .pi/settings.json 注入面)。
    // 注意 sdk 只对自建 loader 调 reload,resources 在装配处已 reload 完毕。
    ...(ctx.resources
      ? { resourceLoader: ctx.resources.resourceLoader, settingsManager: ctx.resources.settingsManager }
      : {}),
  });

  const bridge = createPiEventBridge();
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
  });
  const onAbort = () => {
    void session.abort();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  // steering 轮询(用户问题②):补发消息经 queue/enqueue 端点随时到达,prompt 驱动期
  // 每秒轮询一次编排层的排水回调,新文本交 pi 原生 steer()(入 pi steering 队列,
  // agent-loop 在下一轮工具边界排水注入)。轮询粒度取 1s:补发到注入的最大延迟
  // 远小于任何一轮工具执行/模型响应的时长,用户无感;事件驱动替代方案需要把
  // 会话生命周期泄漏给 HTTP 层,得不偿失。
  const steeringTimer = ctx.pollSteering
    ? setInterval(() => {
        for (const text of ctx.pollSteering!()) {
          // steer() 内部会做 skill/模板展开——补发消息与首轮 prompt 同纪律,
          // 经 _queueSteer 直排可绕开;但那是私有方法,公开面只有 steer()。
          // expandPromptTemplates 已在 prompt 侧关闭,steer() 的展开作用于
          // "/skill:" 前缀等命令形态——会话 UX 不产生该形态,展开为恒等。
          void session.steer(text).catch(() => {
            // 会话已收束(dispose 竞态)时 steer 拒绝:消息已在编排层落库并出队,
            // FIFO 兜底路径不再持有它——按注入失败上报,排查线索进错误中心。
            reportError("provider", "info", "补发消息注入工作区会话失败(会话可能已收束)", undefined, "pi_steer_failed");
          });
        }
      }, 1_000)
    : null;
  try {
    if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    // expandPromptTemplates:false——用户消息逐字直达模型。pi 默认会把 "/" 开头的输入
    // 当模板/扩展命令拦截(agent-session.ts:1122),我们的会话 UX 不走 pi 命令面。
    // runWithLlmRequestLog:本轮生成的 LLM fetch(pi SDK 内部)记入统一日志管线(日志问题 1)。
    await runWithLlmRequestLog(llmLogContextFor(ctx.provider), () =>
      session.prompt(ctx.promptText, {
        expandPromptTemplates: false,
        ...(ctx.images?.length ? { images: ctx.images } : {}),
      }),
    );
  } finally {
    if (steeringTimer) clearInterval(steeringTimer);
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
    // 审批等待者兜底清扫:正常路径下等待者随用户决定/中止即刻注销,这里只防实现
    // 疏漏把 execute 的 Promise 泄漏成永久悬挂(approval-gate 头注)。
    clearToolApprovalWaiters(ctx.conversationId);
  }

  const capturedCompactions = captureRoundCompactions(manager, seededEntryIds, seeded.entryIdsByMessageId);

  const outcome = bridge.outcome();
  // 上游失败且非用户中止 → 抛给调用方失败分支(与聊天引擎 throw 语义一致)。
  // 用户中止 → 正常返回已生成部分,调用方按 signal.aborted 走中止收尾。
  if (outcome.stopReason === "error" && !ctx.signal?.aborted) {
    throw new Error(outcome.errorMessage || "pi 引擎生成失败(未提供错误详情)");
  }
  return {
    text: outcome.text.trim() || "(empty response)",
    degradedMessageIds: seeded.degradedMessageIds,
    stopReason: outcome.stopReason,
    capturedCompactions,
  };
}

// ===== P5:pi 原生手动压缩(P7:压缩记录以会话行为事实源) =====

export interface PiCompactionContext {
  provider: Provider;
  model: Model;
  /** 助手思考强度(同 PiGenerationContext.reasoningLevel;压缩摘要与主会话同档,勿分叉)。 */
  reasoningLevel?: string | null;
  modelLimits?: PiModelLimits;
  conversationId: string;
  cwd: string;
  /** P7:同 runPiGeneration——压缩前的引擎上下文同样从 DB 历史+既有压缩记录重建。 */
  history: Message[];
  compactions?: EngineCompactionRecord[];
  /** 受控资源装配(生产必传:压缩会话也不许打开 .pi/settings.json 注入面)。 */
  resources?: PiSessionResources;
  /** 用户附加指示(compress 框的 additionalPrompt → pi compact customInstructions)。 */
  customInstructions?: string;
  /** 生成事件下沉:压缩路径只产 engine_status(压缩中/摘要重试),经桥同一映射。 */
  sink: GenerationEventSink;
  signal?: AbortSignal;
}

export interface PiCompactionResult {
  summary: string;
  tokensBefore: number;
  /** pi 对压缩后上下文的估算(可选字段,拿不到为 null;仅展示/日志用途)。 */
  estimatedTokensAfter: number | null;
  /** 本次压缩的切点(pi compact 在既有灌注条目里选 firstKeptEntryId,反查必命中;
   *  理论上查不到时为 null,调用方按外收拢语义落尾消息)。 */
  compaction: CapturedEngineCompaction;
}

/** 手动压缩的保留窗口(pi chars/4 估算口径;settingsManager compaction.keepRecentTokens)。
 *
 *  为什么不用 pi 默认 20000:该估算按英文习惯(4 字符≈1 token),中文 1 字≈1+ 真实 token
 *  却只计 0.25——低估 4~6 倍。默认线要消息历史(不含系统提示词/工具定义,它们不进
 *  session entries)累计 8 万字符才可压,中文用户真实上下文近 10 万 token 仍报"过短"
 *  (内测实证:UI 上下文 26.5k 时 /compact 仍拒)。手动压缩=用户明确意图,门槛应低:
 *  2000(≈8000 字符)几乎任何"觉得该压"的会话都能过,压后保留最近 ≈8000 字符 + pi 摘要
 *  (含文件操作/任务状态),连续性足够。自动压缩(threshold/overflow)不走本常量,维持
 *  pi 默认——那是"上下文将溢出"的被动兜底,保留窗口宁大勿小。 */
export const MANUAL_COMPACT_KEEP_RECENT_TOKENS = 2000;

/** pi 已知压缩失败信息 → 业务错误码 + 人话兜底(其余原样上抛,handler 统一转 400)。
 *  errorCode 走 foundation/errors.ts CodedError 通道,前端按码查 i18n 文案。 */
const PI_COMPACT_ERRORS: Record<string, { errorCode: string; message: string }> = {
  "Already compacted": {
    errorCode: "compact_already_compacted",
    message: "引擎记忆刚完成压缩,无需再次压缩。",
  },
  "Nothing to compact (session too small)": {
    errorCode: "compact_context_too_short",
    message: "当前会话上下文过短,暂不需要压缩。",
  },
};

/**
 * 手动压缩工作区会话(方案 P5:手动压缩按钮改调 pi 原生 compaction;P7 落点)。
 * 装配面与 runPiGeneration 同款(模型运行时/受控资源/事件桥),差别只在驱动动作:
 * prompt → session.compact。压缩产物(摘要/切点/tokensBefore)返回给调用方落
 * conversation.engineCompactions,UI 历史不动——下一轮生成由编码器重放压缩语义。
 */
export async function runPiCompaction(ctx: PiCompactionContext): Promise<PiCompactionResult> {
  if (ctx.signal?.aborted) throw new DOMException("Compaction cancelled", "AbortError");
  const mapped = mapProviderModelToPi(ctx.provider, ctx.model, ctx.modelLimits, ctx.conversationId);
  if (!mapped.ok) throw new Error(`该模型无法在工作区引擎使用：${mapped.reason}`);
  const { runtime, model } = await createPiModelRuntime(mapped.mapping);

  const manager = SessionManager.inMemory(ctx.cwd);
  const seeded = seedPiSessionFromHistory({
    manager,
    history: ctx.history,
    model: ctx.model,
    compactions: ctx.compactions,
  });
  const seededEntryIds = new Set(manager.getEntries().map((entry) => entry.id));

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: piAgentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    // 压缩会话同档位:摘要质量受益于推理,且与主会话口径一致(勿分叉)。
    thinkingLevel: piThinkingLevelFor(ctx.reasoningLevel),
    noTools: "builtin",
    customTools: [],
    ...(ctx.resources
      ? { resourceLoader: ctx.resources.resourceLoader, settingsManager: ctx.resources.settingsManager }
      : {}),
  });

  const bridge = createPiEventBridge();
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
  });
  const onAbort = () => {
    session.abortCompaction();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (ctx.signal?.aborted) throw new DOMException("Compaction cancelled", "AbortError");
    const result = await runWithLlmRequestLog(llmLogContextFor(ctx.provider), () =>
      session.compact(ctx.customInstructions?.trim() || undefined),
    );
    const captured = captureRoundCompactions(manager, seededEntryIds, seeded.entryIdsByMessageId).at(-1);
    if (!captured) {
      // compact 成功却找不到新 compaction 条目 = pi 内部行为漂移,按失败处理比静默丢摘要安全。
      throw new Error("工作区引擎压缩完成但未产生压缩条目");
    }
    return {
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter ?? null,
      compaction: captured,
    };
  } catch (err) {
    // 取消统一为 AbortError(compact 内部以普通 Error("Compaction cancelled") 上抛)。
    const message = err instanceof Error ? err.message : String(err);
    if (ctx.signal?.aborted || message === "Compaction cancelled") {
      throw new DOMException("Compaction cancelled", "AbortError");
    }
    const known = PI_COMPACT_ERRORS[message];
    if (known) throw new CodedError(known.message, known.errorCode);
    throw new Error(`工作区引擎压缩失败：${message}`);
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}
