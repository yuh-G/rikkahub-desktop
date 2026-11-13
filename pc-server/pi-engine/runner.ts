// pi-engine/runner.ts — pi 会话生成驱动器(P2 骨架;P7 重写为统一会话数据)
//
// 一次调用 = 我们会话模型里的一轮生成:注入模型运行时(P1 model-bridge)→ 把应用给的会话
// 视图装进内存 SessionManager(session-view:有效原生条目原样、其余回退编码;inMemory,零 jsonl)→
// 订阅事件经桥(event-bridge)映射为 GenerationEvent 灌进调用方 sink(生产侧即
// host.emit)→ prompt 等待回合结束 → 按桥观察到的终局决定
// return/throw,顺手捕获本轮 pi 自动压缩产物(摘要以会话行为事实源,见下)。
//
// 契约与聊天引擎流式函数对齐:sink 语义相同、abort 经 AbortSignal、上游失败以 throw
// 上抛(应用侧 generateAnswer 的失败分支统一做 reportError/失败文本/注解)。生产调用方是
// pi-engine/driver(EngineDriver 实现,输入全部来自契约)。
//
// 会话数据(方案 §4.7 / §5.4):引擎上下文每轮由会话视图重建,不再有会话↔jsonl 文件关联。
// 本轮新增的 pi 条目经 ctx.appendEntries 交给应用(session-view 的 createPiEntrySync:事件边界、
// 补发换绑之前、轮末三处对账),应用锚定到当前落点、正常结束后封存,下一轮装载时原样取用。
// pi 自动压缩发生在 prompt 内部,结果捕获为 capturedCompactions(firstKeptEntryId 反查视图的
// 条目映射回到消息 id),由调用方落 conversation.engineCompactions;原生压缩条目随本轮的对账
// 落进私有表。下一轮由 session-view 按记录决定压缩,配得上原生条目则原样取用(P3.5)。
// 视图是富化全序列(含合成行,应用以压缩切点为富化窗口锚),聊天位注入/时间提醒在工作区会话
// 与聊天引擎逐字同生效。
//
// P3 工具面:noTools:"builtin"——pi 内建 read/bash/edit/write 一律不启用(它们绕开
// 我们的审批与边界壳),应用工具规格(ctx.tools)经 pi-engine/app-tools 包成 customTools,
// 调用交回应用(ctx.callTool,审批与执行在应用侧)。不传 tools 即纯对话
// (无任何激活工具,系统提示词 Available tools 为 "(none)")。

import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";
import { markRuntimeStreamFunction } from "../../pi/packages/coding-agent/src/core/agent-session.ts";
import type { ModelRuntime } from "../../pi/packages/coding-agent/src/core/model-runtime.ts";
import type { StreamFn } from "../../pi/packages/agent/src/types.ts";

import type { SessionManager } from "../../pi/packages/coding-agent/src/core/session-manager.ts";
import type { GenerationEventSink } from "../inference-engine/events";
import { piAgentDir } from "../foundation/paths";
import { CodedError } from "../foundation/errors";
import {
  createPiModelRuntime,
  mapGrantToPi,
  piCacheRetentionFor,
  piThinkingLevelFor,
  type PiModelMapping,
  type SubscriptionCredentialSource,
} from "./model-bridge";
import { googleRequestLogContextFor, runWithGoogleRequestLog } from "./llm-request-log";
import { createModelOutlet, type ModelRequestLog } from "../engines/model-outlet";
import { createPiEventBridge } from "./event-bridge";
import type { PiSessionResources } from "./resources";
import type {
  AppToolSpec,
  CapturedEngineCompaction,
  EngineEntryInput,
  EngineErrorReport,
  EngineSessionView,
  ModelGrant,
} from "../engines/contract";
import { createPiAppTools, type PiAppToolCaller } from "./app-tools";
import { createPiEntrySync, createPiSessionFromView, toPiEngineEntry } from "./session-view";

export interface PiGenerationContext {
  /** 本轮模型授权(应用侧 engines/model-grant 组装:上限/请求头已是终值)。limits.contextWindow
   *  决定 pi 自动压缩阈值(contextWindow - reserveTokens),必须尽量真实。 */
  grant: ModelGrant;
  /** 订阅凭据取用口(生产 = host.models.credential);API Key 授权用不到。 */
  credentialSource?: SubscriptionCredentialSource;
  /** 模型请求日志(生产 = host.models.log)。不传 = 不记(测试/冒烟)。 */
  requestLog?: ModelRequestLog;
  /** 助手思考强度(assistant.reasoningLevel 原值;经 piThinkingLevelFor 译成 pi 档位:
   *  off→off、六档直传、auto/未知→medium)。不传=medium(纯测试/冒烟场景)。 */
  reasoningLevel?: string | null;
  /** 会话身份:pi 会话 id 取它(prompt_cache_key 与会话亲和头跨轮稳定)。 */
  conversationId: string;
  /** 会话工作目录(工作区边界内的绝对路径)。 */
  cwd: string;
  /** 会话视图(生产 = host.session.load):富化全序列,含合成行与既有压缩记录,不含本轮新用户
   *  输入——那条走 session.prompt。 */
  view: EngineSessionView;
  /** 本轮用户输入(文本;文档/OCR 已由 inference-engine/prompt-input 文本化)。 */
  promptText: string;
  /** 图片附件(pi 原生 prompt images 通道,P4 附件面)。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** 资源装配(P4:技能/AGENTS.md/appendSystemPrompt/受控 settings,
   *  生产侧 = createPiSessionResources;不传 = 纯对话,pi 默认资源面全关不了——
   *  仅测试/冒烟场景使用,生产路由必须传)。 */
  resources?: PiSessionResources;
  /** 应用工具规格(生产侧 = 工作区工具 + 通用工具/MCP 桥;不传 = 纯对话)。 */
  tools?: AppToolSpec[];
  /** 应用工具调用口(生产 = host.tools.call:审批/执行/实体化在应用侧)。 */
  callTool?: PiAppToolCaller;
  /** 诊断出口(生产 = host.report;自动压缩失败等经它进应用错误中心)。 */
  report?: (report: EngineErrorReport) => void;
  /** 本轮新增的 pi 原生条目交给应用(生产 = host.session.append,应用按当前落点锚定)。不传 = 不写
   *  (测试/冒烟)。轮次返回前已全部送达。 */
  appendEntries?: (entries: EngineEntryInput[]) => Promise<void>;
  /** 生成事件下沉(生产侧 = host.emit,应用侧接 conversations/generation-apply 的应用器)。 */
  sink: GenerationEventSink;
  signal?: AbortSignal;
  /** steering 轮边界(用户问题②,对齐 Codex pending_input):生成中补发的用户消息取流
   *  (生产 = host.steer.take)。runner 在 pi 的 turn_end(当前 assistant 消息结束、其工具
   *  全部执行完)调用并等它返回,文本经 session.agent.steer() 入 pi steering 队列——agent-loop
   *  紧接着在「下一次 LLM 调用前」排水注入(runLoop 的 turn_end 后 getSteeringMessages)。
   *  调用时刻 = 注入时刻 = 应用做数据层分裂的时刻,三者同点;与聊天引擎工具循环的
   *  调用位、Codex 的 pending_input 排水位同构。不传 = 无 steering 能力(消息留在 FIFO
   *  队列收尾派发兜底)。落库/队列联动在应用侧,runner 零副作用。 */
  onSteerBoundary?: () => string[] | Promise<string[]>;
}

export interface PiGenerationResult {
  /** 全程 assistant 可见文本(镜像聊天引擎 allContent 口径:trim,空则占位)。 */
  text: string;
  /** 装载时走了 legacy 退化的 assistant 行 id(诊断;注解失配=用户编辑过历史)。 */
  degradedMessageIds: string[];
  stopReason: string | null;
  capturedCompactions: CapturedEngineCompaction[];
}

/** 本轮新增的压缩条目 → DB 压缩记录。切点反查视图的条目映射(assistant 行一条消息产
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

/** 授权的缓存策略注入 agent 的流函数。会话请求与 pi 缓存预热的重放都从这里拿到选项(预热按
 *  请求选项算保留期,关时自行停下),所以注入点必须在 sdk 流函数之外,而不是更底层的运行时。
 *  显式值优先:pi 的摘要/压缩请求自带 cacheRetention:"none"。包装后重新登记为「经运行时自行
 *  鉴权」的流函数——不登记的话 pi 摘要路径会预解析凭据,订阅登录被当成显式 API Key(上游 #11520)。 */
function applyPromptCachePolicy(agent: { streamFunction: StreamFn }, runtime: ModelRuntime, grant: ModelGrant): void {
  const cacheRetention = piCacheRetentionFor(grant.promptCache);
  const inner = agent.streamFunction;
  const wrapped: StreamFn = (model, context, options) =>
    inner(model, context, { ...options, cacheRetention: options?.cacheRetention ?? cacheRetention });
  agent.streamFunction = wrapped;
  markRuntimeStreamFunction(wrapped, runtime);
}

/** 模型运行时 + 模型出口:本轮的模型请求经带供应商身份的 fetch 发出并记日志(google 轨除外,见
 *  llm-request-log 头注)。 */
function createModelRuntimeFor(
  mapping: PiModelMapping,
  ctx: Pick<PiGenerationContext, "grant" | "credentialSource" | "requestLog">,
) {
  const { requestLog } = ctx;
  const outlet = requestLog
    ? createModelOutlet({ providerId: ctx.grant.providerId, providerName: ctx.grant.providerName }, requestLog)
    : undefined;
  return createPiModelRuntime(mapping, ctx.credentialSource, outlet);
}

/** 会话装载完成后建对账器(不传 appendEntries = 不写)。送达失败报一次 warn。 */
function entrySyncFor(manager: SessionManager, ctx: Pick<PiGenerationContext, "appendEntries" | "report">) {
  const { appendEntries } = ctx;
  if (!appendEntries) return undefined;
  return createPiEntrySync(manager, appendEntries, (error) =>
    ctx.report?.({
      domain: "pi-engine",
      severity: "warn",
      message: "工作区会话的引擎记录未能保存,下一轮这部分历史按界面内容重建(思考签名等引擎数据不保留)",
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
}

export async function runPiGeneration(ctx: PiGenerationContext): Promise<PiGenerationResult> {
  if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  const mapped = mapGrantToPi(ctx.grant);
  if (!mapped.ok) throw new Error(`该模型无法在工作区引擎使用：${mapped.reason}`);
  const { runtime, model } = await createModelRuntimeFor(mapped.mapping, ctx);

  // 引擎上下文每轮由会话视图重建,inMemory 会话零文件生命周期。
  const seeded = createPiSessionFromView({
    cwd: ctx.cwd,
    conversationId: ctx.conversationId,
    view: ctx.view,
    fallbackModelId: ctx.grant.modelId,
  });
  const manager = seeded.manager;
  const seededEntryIds = new Set(manager.getEntries().map((entry) => entry.id));
  const entrySync = entrySyncFor(manager, ctx);

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: piAgentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    thinkingLevel: piThinkingLevelFor(ctx.reasoningLevel),
    // "builtin" 只关内建工具;customTools 经 includeAllExtensionTools 全部激活
    // (agent-session.ts 的 includeAllExtensionTools + _refreshToolRegistry,§七-3 实证)。
    noTools: "builtin",
    customTools: createPiAppTools(ctx.tools ?? [], ctx.callTool),
    // P4 资源统一:受控 ResourceLoader(技能白名单/AGENTS.md 边界过滤/appendSystemPrompt)
    // + 受控 SettingsManager(inMemory,封死 .pi/settings.json 注入面)。
    // 注意 sdk 只对自建 loader 调 reload,resources 在装配处已 reload 完毕。
    ...(ctx.resources
      ? { resourceLoader: ctx.resources.resourceLoader, settingsManager: ctx.resources.settingsManager }
      : {}),
  });

  // steering 一次吸收全部:与聊天引擎 steerBoundary 整批排水、Codex pending_input
  // split_off(0) 同语义——多条插话 = 多个 user 气泡 + 一个 ai_2,不按轮次逐条滴灌。
  session.agent.steeringMode = "all";
  applyPromptCachePolicy(session.agent, runtime, ctx.grant);

  const bridge = createPiEventBridge({ report: ctx.report });
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
    // 流式增量之外的每个事件都是对账点。message_end 的落库在事件派发之后,那一条由下一个事件交出。
    if (event.type !== "message_update" && event.type !== "tool_execution_update" && event.type !== "bash_execution_update") {
      void entrySync?.flush();
    }
  });
  // steering 轮边界(用户问题②):turn_end = 当前 assistant 消息结束、其工具批已执行完。
  // 挂在 agent 级监听器上而不是 session.subscribe:Agent.processEvents 逐个 await agent 级
  // 监听器,agent-loop 等 turn_end 的全部监听器返回后才 getSteeringMessages 排水,所以这里
  // 可以 await 取补发(跨进程时它是一次往返)。AgentSession 自己的处理器在构造时先注册,
  // 轮到这里时桥已经处理过本次 turn_end。
  // 入队直调 session.agent.steer({...})(同步 push steeringQueue)。不走 session.steer():
  // pi 1.0 起它先 await 输入钩子(agent-session._queueUserInput)再入队,跳过的只有输入钩子
  // (noExtensions 下恒等)与 "/skill:"/模板展开(会话 UX 不产生 "/" 命令形态,恒等)。
  // 接入 pi 插件后此路径会绕过插件 input 钩子,届时重评(方案 §8 P1)。
  // 应用在同一调用里完成数据层分裂(定格 ai_1 / 落 steer user / 开 ai_2 / 换绑),
  // 于是分裂时刻与 pi 注入时刻逐字同点。此前用 1s 定时器轮询,分裂落在模型仍在流式
  // 的任意时刻,ai_1 多半还是空占位(2026-09-20 用户实测 2-1)。
  const onSteerBoundary = ctx.onSteerBoundary;
  const unsubscribeSteer = onSteerBoundary
    ? session.agent.subscribe(async (event) => {
        if (event.type !== "turn_end") return;
        // 应用在 take 里换绑落点,这一段的条目必须先落到旧落点上。
        await entrySync?.flush();
        const texts = await onSteerBoundary();
        if (texts.length === 0) return;
        // 注入即分段:应用已换绑落点,桥的终局文本切到新气泡口径。
        bridge.beginSegment();
        for (const text of texts) {
          session.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
        }
      })
    : undefined;
  const onAbort = () => {
    void session.abort();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    // expandPromptTemplates:false——用户消息逐字直达模型。pi 默认会把 "/" 开头的输入
    // 当模板/扩展命令拦截(agent-session.ts prompt() 的 expandPromptTemplates 分支),我们的会话 UX 不走 pi 命令面。
    await runWithGoogleRequestLog(googleRequestLogContextFor(model.api, ctx.grant, ctx.requestLog), () =>
      session.prompt(ctx.promptText, {
        expandPromptTemplates: false,
        ...(ctx.images?.length ? { images: ctx.images } : {}),
      }),
    );
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribeSteer?.();
    unsubscribe();
    session.dispose();
    // 轮末对账:收尾前最后一批(含中止、失败的轮次;它们不会被封存,装载时作废)。
    await entrySync?.flush();
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
  /** 执行摘要的模型授权(同 PiGenerationContext.grant)。 */
  grant: ModelGrant;
  credentialSource?: SubscriptionCredentialSource;
  requestLog?: ModelRequestLog;
  /** 助手思考强度(同 PiGenerationContext.reasoningLevel;压缩摘要与主会话同档,勿分叉)。 */
  reasoningLevel?: string | null;
  conversationId: string;
  cwd: string;
  /** 同 runPiGeneration——压缩前的引擎上下文同样由会话视图重建(压缩调用的视图只含真实行)。 */
  view: EngineSessionView;
  /** 受控资源装配(生产必传:压缩会话也不许打开 .pi/settings.json 注入面)。 */
  resources?: PiSessionResources;
  /** 用户附加指示(compress 框的 additionalPrompt → pi compact customInstructions)。 */
  customInstructions?: string;
  /** 生成事件下沉:压缩路径只产 engine_status(压缩中/摘要重试),经桥同一映射。 */
  sink: GenerationEventSink;
  report?: (report: EngineErrorReport) => void;
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
  /** pi 的原生压缩条目(details 里有文件操作清单,下一次压缩据此累计)。 */
  native?: EngineEntryInput;
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
  const mapped = mapGrantToPi(ctx.grant);
  if (!mapped.ok) throw new Error(`该模型无法在工作区引擎使用：${mapped.reason}`);
  const { runtime, model } = await createModelRuntimeFor(mapped.mapping, ctx);

  const seeded = createPiSessionFromView({
    cwd: ctx.cwd,
    conversationId: ctx.conversationId,
    view: ctx.view,
    fallbackModelId: ctx.grant.modelId,
  });
  const manager = seeded.manager;
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

  const bridge = createPiEventBridge({ report: ctx.report });
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
  });
  const onAbort = () => {
    session.abortCompaction();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (ctx.signal?.aborted) throw new DOMException("Compaction cancelled", "AbortError");
    const result = await runWithGoogleRequestLog(googleRequestLogContextFor(model.api, ctx.grant, ctx.requestLog), () =>
      session.compact(ctx.customInstructions?.trim() || undefined),
    );
    const captured = captureRoundCompactions(manager, seededEntryIds, seeded.entryIdsByMessageId).at(-1);
    if (!captured) {
      // compact 成功却找不到新 compaction 条目 = pi 内部行为漂移,按失败处理比静默丢摘要安全。
      throw new Error("工作区引擎压缩完成但未产生压缩条目");
    }
    const nativeEntry = manager.getEntries().findLast((entry) => entry.type === "compaction" && !seededEntryIds.has(entry.id));
    return {
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter ?? null,
      compaction: captured,
      ...(nativeEntry ? { native: toPiEngineEntry(nativeEntry) } : {}),
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
