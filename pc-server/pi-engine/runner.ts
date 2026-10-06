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
import type { StreamFn } from "../../pi/packages/agent/src/types.ts";
import type { GenerationEventSink } from "../inference-engine/events";
import type { Message, Model, Provider } from "../foundation/types";
import { piAgentDir } from "../foundation/paths";
import { CodedError } from "../foundation/errors";
import { promptCachePolicyFor } from "../model-providers/prompt-cache";
import type { LlmFetch } from "../inference-engine/llm-transport";
import { createPiModelRuntime, mapProviderModelToPi, piThinkingLevelFor, type PiModelLimits } from "./model-bridge";
import { llmLogContextFor, runWithLlmRequestLog } from "./llm-request-log";
import { createPiEventBridge } from "./event-bridge";
import { clearToolApprovalWaiters } from "../inference-engine/approval-gate";
import type { PiSessionResources } from "./resources";
import { seedPiSessionFromHistory, type EngineCompactionRecord } from "./context-encoder";
import { sweepWorkspaceReservedNameArtifacts } from "../workspace/files";

export interface PiGenerationContext {
  /** 生效 provider/model(调用方经 findModel 解析,providerOverwrite 已展开)。 */
  provider: Provider;
  model: Model;
  /** LLM 请求通道(T3):pi SDK 内部发出的每条请求经此出口——请求日志 / 缓存预热捕获作为
   *  有序中间件挂在其上,身份(会话/供应商/用途)由组装点显式给出,不再叠全局 fetch 壳。
   *  组装点见编排层(llmMiddlewaresFor)。pi 内建 google 适配器拒收自定义 fetch(§2.3 P5),
   *  包装器按 provider.type 判定不注入(见 runPiGeneration 内 withLlmFetch 头注)。 */
  llmFetch: LlmFetch;
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
  /** steering 轮边界(用户问题②,对齐 Codex pending_input):生成中补发的用户消息取流。
   *  runner 在 pi 的 turn_end(当前 assistant 消息结束、其工具全部执行完)同步调用本回调,
   *  返回的文本经 session.agent.steer() 同步入 pi steering 队列——agent-loop 紧接着在
   *  「下一次 LLM 调用前」排水注入(agent-loop.ts runLoop 的 turn_end 后 getSteeringMessages)。
   *  调用时刻 = 注入时刻 = 编排层做数据层分裂的时刻,三者同点;与聊天引擎工具循环的
   *  调用位、Codex 的 pending_input 排水位同构。不传 = 无 steering 能力(消息留在 FIFO
   *  队列收尾派发兜底)。回调由编排层实现(落库/队列联动在编排层,runner 零副作用)。 */
  onSteerBoundary?: () => string[];
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

/** pi 的 cacheRetention(策略单源翻译,C1)。anthropicCaching 关 = "none"(工作区请求
 *  随「Claude 提示缓存」开关逐字收敛,修复 S6:此前 pi 默认 short 恒打 cache_control);
 *  开则 TTL 决定 short/long。OpenAI 格式:openaiCacheKey 开 = "short"(pi 会话 id 已
 *  稳定成 conversationId,Responses/completions 由此发 prompt_cache_key 做缓存路由)、
 *  关 = "none"。其他协议(google)pi 原生不消费该值,给 none 亦无副作用。
 *  订阅 Claude 行恒开规则住在策略函数里(model-providers/prompt-cache),本翻译层
 *  零业务规则——未来引擎照此翻译即可继承同款语义。 */
function piCacheRetentionFor(provider: Provider): "none" | "short" | "long" {
  const policy = promptCachePolicyFor(provider);
  if (provider.type === "claude") {
    if (!policy.anthropicCaching) return "none";
    return policy.anthropicTtl === "1h" ? "long" : "short";
  }
  if (provider.type === "openai") return policy.openaiCacheKey ? "short" : "none";
  return "none";
}

/** 会话组装公共件:每轮生成的 pi SessionManager 用 conversationId 作会话 id——
 *  pi 的 prompt_cache_key(Responses/completions 的缓存路由键)与 OpenRouter 亲和头
 *  都读它,稳定 id 让缓存路由跨轮命中(此前每轮随机 uuidv7,同会话永远打不进同一
 *  缓存分片)。与 §7.4 会话身份头同一值:「缓存路由身份」与「限流分桶身份」统一为
 *  会话 id。会话 id 须过 pi 的字符白名单(字母数字与 -_.),宿主会话 id 是 uuid,
 *  天然合法;防御性替换非白名单字符(断言形状,不发明新 id)。 */
function piSessionManagerFor(cwd: string, conversationId: string): SessionManager {
  const safeId = conversationId.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
  return SessionManager.inMemory(cwd, { id: safeId });
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

/** pi 是否可注入自定义 fetch = 是否非 google 轨(§2.3 P5:pi 的 google-generative-ai /
 *  google-vertex 适配器收到非全局 fetch 直接抛 "Custom fetch is not supported")。
 *  单点判定,StreamFn 包装与测试共用;将来 pi 支持 google 注入或新增同类协议,只改这里。 */
export function piInjectsLlmFetch(provider: Provider): boolean {
  return provider.type !== "google";
}

/** 把 LLM 请求通道注入 pi 的 streamFunction 包装器公共件(生成与手动压缩都用)。
 *
 *  - `options?.fetch ?? ctx.llmFetch` 语义与 C1 的 cacheRetention 同款:pi 内部显式给的
 *    fetch 不覆盖(对称于 compaction 自带的 cacheRetention:"none")。
 *  - **google 例外**(见 piInjectsLlmFetch):不注入时,pi google 轨的请求日志由一层窄全局
 *    壳兜底(runner 的 runWithProviderLog + bootstrap 的 installLlmRequestLogInterceptor,
 *    「上游支持注入 fetch 后删除」)。
 *  - 这是 pi 官方公开扩展点(session.agent.streamFunction),非补丁;上游若重构流路径,
 *    失效形态是"请求不经通道"(回到全局 fetch),集成锁(cache-retention / pi-route)先红。 */
function withLlmFetch(streamFn: StreamFn, provider: Provider, llmFetch: LlmFetch): StreamFn {
  if (!piInjectsLlmFetch(provider)) return streamFn;
  return (model, context, options) =>
    streamFn(model, context, { ...options, fetch: options?.fetch ?? llmFetch });
}

/** google 例外的日志兜底(§2.3 P5,决策 b):pi 的 google 适配器拒收自定义 fetch,其请求
 *  不经 LLM 通道,故**只在 pi google 轨**用这层窄全局日志壳补记——只记日志、不预热。
 *  其余协议经 withLlmFetch 走通道记日志,不走这里(零双记)。
 *  拆除条件:上游支持注入 fetch 后,随 installLlmRequestLogInterceptor 一并删除
 *  (CLAUDE.md pi 维护手册「清除冗余」条目已登记)。 */
function runWithProviderLog<T>(provider: Provider, fn: () => T): T {
  if (provider.type !== "google") return fn();
  return runWithLlmRequestLog(llmLogContextFor(provider), fn);
}

export async function runPiGeneration(ctx: PiGenerationContext): Promise<PiGenerationResult> {
  if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  const mapped = mapProviderModelToPi(ctx.provider, ctx.model, ctx.modelLimits, ctx.conversationId);
  if (!mapped.ok) throw new Error(`该模型无法在工作区引擎使用：${mapped.reason}`);
  const { runtime, model } = await createPiModelRuntime(mapped.mapping);

  // 问题4(2.0.0 内测):每轮生成前清扫工作区根的 Windows 保留设备名残留(nul 等)——
  // 兼作存量自愈:内测期已产生的残留在用户下次使用该工作区时自动消失。
  sweepWorkspaceReservedNameArtifacts(ctx.cwd);

  // P7:引擎上下文从 SQLite 历史每轮重建,inMemory 会话零文件生命周期。会话 id 用
  // conversationId(piSessionManagerFor:缓存路由/亲和头跨轮稳定)。
  const manager = piSessionManagerFor(ctx.cwd, ctx.conversationId);
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
    // (agent-session.ts:495 includeAllExtensionTools + _refreshToolRegistry,§七-3 实证)。
    noTools: "builtin",
    customTools: ctx.tools ?? [],
    // P4 资源统一:受控 ResourceLoader(技能白名单/AGENTS.md 边界过滤/appendSystemPrompt)
    // + 受控 SettingsManager(inMemory,封死 .pi/settings.json 注入面)。
    // 注意 sdk 只对自建 loader 调 reload,resources 在装配处已 reload 完毕。
    ...(ctx.resources
      ? { resourceLoader: ctx.resources.resourceLoader, settingsManager: ctx.resources.settingsManager }
      : {}),
  });

  // C1 缓存策略注入:包一层 streamFunction 把策略翻译的 cacheRetention 塞进 options
  // (sdk 的 buildRequestOptions 以 ...options 透传)。`?? 策略值` 语义 = 显式值优先:
  // pi 压缩/摘要请求自带 cacheRetention:"none"(compaction.ts completeSummarization),
  // 包装器不得覆盖。这是 pi 官方公开扩展点(proxy 流同款),非补丁;上游若重构
  // streamFn 内部结构,失效形态是"回到 pi 默认 short",行为锁测试会先红。
  const cacheRetention = piCacheRetentionFor(ctx.provider);
  const innerStreamFn = session.agent.streamFunction;
  const wrappedStreamFn: StreamFn = (model_, context, options) =>
    innerStreamFn(model_, context, { ...options, cacheRetention: options?.cacheRetention ?? cacheRetention });
  // T3:同一包装器上再叠 LLM 通道注入(fetch)。包装后的函数本身就是 StreamFn,故直接把
  // 通道注入叠在策略包装外层(顺序无关:两者读/写 options 的不同字段)。
  session.agent.streamFunction = withLlmFetch(wrappedStreamFn, ctx.provider, ctx.llmFetch);

  // steering 一次吸收全部:与聊天引擎 steerBoundary 整批排水、Codex pending_input
  // split_off(0) 同语义——多条插话 = 多个 user 气泡 + 一个 ai_2,不按轮次逐条滴灌。
  session.agent.steeringMode = "all";

  const bridge = createPiEventBridge();
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
    // steering 轮边界(用户问题②):turn_end = 当前 assistant 消息结束、其工具批已执行完,
    // agent-loop 紧接着 getSteeringMessages 排水(顺序 await 各监听器后再查队列)。这里
    // 直调 session.agent.steer({...})——同步入队(agent.ts 只 push steeringQueue),保证
    // 「pi 查队列之前消息已在队列」。不走 session.steer():pi 1.0 起它先 await 输入钩子
    // (agent-session._queueUserInput)再入队,而我们的 turn_end 回调不 await 它,入队被
    // 推迟至少一个微任务——排水可能先查、消息晚到(pi 有下轮兜底不丢,但会晚一轮送达,
    // 破坏注入时刻=分段时刻)。跳过的只有输入钩子(noExtensions 下恒等)与 "/skill:"
    // /模板展开(会话 UX 不产生 "/" 命令形态,恒等)。接入 pi 插件后此路径会绕过插件
    // input 钩子,届时重评(方案 §8 P1)。
    // 编排层在同一调用里完成数据层分裂(定格 ai_1 / 落 steer user / 开 ai_2 / 换绑),
    // 于是分裂时刻与 pi 注入时刻逐字同点。此前用 1s 定时器轮询,分裂落在模型仍在流式
    // 的任意时刻,ai_1 多半还是空占位(2026-09-20 用户实测 2-1)。
    if (event.type === "turn_end" && ctx.onSteerBoundary) {
      const texts = ctx.onSteerBoundary();
      if (texts.length === 0) return;
      // 注入即分段:编排层已换绑落点,桥的终局文本/保真序号切到新气泡口径。
      bridge.beginSegment();
      for (const text of texts) {
        session.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      }
    }
  });
  const onAbort = () => {
    void session.abort();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    // expandPromptTemplates:false——用户消息逐字直达模型。pi 默认会把 "/" 开头的输入
    // 当模板/扩展命令拦截(agent-session.ts:1926-1931),我们的会话 UX 不走 pi 命令面。
    // T3:本轮生成的 LLM fetch(pi SDK 内部)经 ctx.llmFetch 通道记入统一日志管线(见
    // streamFunction 包装);google 轨不经通道,由 runWithProviderLog 的窄壳兜底补记。
    await runWithProviderLog(ctx.provider, () =>
      session.prompt(ctx.promptText, {
        expandPromptTemplates: false,
        ...(ctx.images?.length ? { images: ctx.images } : {}),
      }),
    );
  } finally {
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
  /** LLM 请求通道(T3;同 PiGenerationContext.llmFetch)——压缩摘要请求走它记日志。 */
  llmFetch: LlmFetch;
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

  // 会话 id 同生成路径(piSessionManagerFor);压缩请求自带的 cacheRetention:"none"
  // 在 pi 内部(completeSummarization),不经我们的包装面,天然不受策略影响。
  const manager = piSessionManagerFor(ctx.cwd, ctx.conversationId);
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

  // T3:压缩摘要请求经同一 LLM 通道记日志(P3:压缩走 this.agent.streamFunction,与主循环
  // 同注入点)。压缩自带 cacheRetention:"none"(compaction.ts completeSummarization),
  // 不经我们的策略包装面,故这里只叠通道注入。
  session.agent.streamFunction = withLlmFetch(session.agent.streamFunction, ctx.provider, ctx.llmFetch);

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
    const result = await runWithProviderLog(ctx.provider, () =>
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
