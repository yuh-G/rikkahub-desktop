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
// 与聊天引擎逐字同生效。合成行不进会话条目,每次请求前经 transformContext 插到锚点之前。
//
// 长驻会话(P5.6,ctx.sessions):活会话与本轮视图重建出的会话按模型可见内容逐条相同、配置键也相同时
// 接着用(插件内存态、模型运行时、工具定义都留着),否则关掉重建;复用与回收见 session-host。不给
// sessions 时每轮新建、轮末关掉,与 P5.6 之前相同。
//
// 工具面(P4b):工作区工具是 pi 的内建工具定义,但由我们创建(builtin-tools:应用后端 + 执行前审批),
// 以 customTools 进会话;noTools:"builtin" 保持不变——pi 自己不创建任何默认后端的内建工具,本轮不提供的
// 内建工具名经 excludeTools 连登记都拿掉。应用工具规格(ctx.tools,通用工具 / MCP 桥)经 app-tools 包成
// customTools,调用交回应用(ctx.callTool)。会话就绪后 assertPiToolsGated 核对每个已登记工具都带应用
// 闸门标记,否则不开跑。都不传即纯对话(无任何激活工具,系统提示词 Available tools 为 "(none)")。

import { createHash } from "node:crypto";

import { createAgentSession } from "../../pi/packages/coding-agent/src/core/sdk.ts";
import { markRuntimeStreamFunction } from "../../pi/packages/coding-agent/src/core/agent-session.ts";
import type { ModelRuntime } from "../../pi/packages/coding-agent/src/core/model-runtime.ts";
import type { StreamFn } from "../../pi/packages/agent/src/types.ts";
import { allToolNames } from "../../pi/packages/coding-agent/src/core/tools/index.ts";

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
import { createPiBuiltinTools, excludedPiBuiltinToolNames, type PiBuiltinToolApprover } from "./builtin-tools";
import { assertPiToolsGated } from "./tool-gate";
import { runAsPiChildOwner, type PiChildSessionOwner } from "./child-sessions";
import { bindPiPluginSession, type PiPluginSessionBinding } from "./plugins/session-binding";
import { runAsPiPlugin, takePiPluginVeto, type PiPluginToolApprover } from "./plugins/arbiter";
import { findPiPluginCommand } from "./plugins/commands";
import { pluginIdForTool } from "./plugins/entries";
import type { PiPluginInteraction } from "./plugins/ui-bridge";
import {
  EMPTY_SYNTHETIC_PLAN,
  createPiEntrySync,
  createPiSessionFromView,
  matchLiveSession,
  planSyntheticRows,
  toPiEngineEntry,
  type PiEntrySync,
  type PiSessionFromView,
} from "./session-view";
import { clearTurnRoutes, createPiLiveSession, type PiLiveSession, type PiSessionHost, type PiTurnRoutes } from "./session-host";

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
   *  仅测试/冒烟场景使用,生产路由必须传)。传函数 = 只在新建会话时装配(接着用活会话时不调),
   *  参数是委托到当前轮的插件工具审批口。 */
  resources?: PiSessionResources | ((approvePluginTool: PiPluginToolApprover) => Promise<PiSessionResources>);
  /** 应用工具规格(生产侧 = 通用工具/MCP 桥;不传 = 没有应用工具)。 */
  tools?: AppToolSpec[];
  /** 应用工具调用口(生产 = host.tools.call:审批/执行/实体化在应用侧)。 */
  callTool?: PiAppToolCaller;
  /** 工作区工具(pi 内建定义 + 应用后端)。不传 = 没有工作区工具(纯对话 / 测试)。 */
  workspaceTools?: {
    root: string;
    /** 可用 bash;缺省挂 grep / find / ls 兜底。 */
    shell?: string;
    /** 执行前审批(生产 = host.permission.check,来源 engine)。 */
    approve: PiBuiltinToolApprover;
  };
  /** 诊断出口(生产 = host.report;自动压缩失败等经它进应用错误中心)。 */
  report?: (report: EngineErrorReport) => void;
  /** 插件的界面通道(生产 = host.interaction,绑本轮 turnId)。不传 = 插件看到 pi 的空界面(测试/冒烟)。 */
  interaction?: PiPluginInteraction;
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
  /** 插件工具执行前的应用审批(生产 = host.permission.check,来源 plugin)。resources 传函数时经它委托。 */
  approvePluginTool?: PiPluginToolApprover;
  /** 长驻会话(P5.6):给了就跨轮复用活会话(session-host);key 是调用方给的、配置键里 ctx 看不到的
   *  部分(指令、插件清单)。不给 = 每轮新建、轮末关掉(测试/冒烟)。 */
  sessions?: { host: PiSessionHost; key: string };
  /** 应用响应 host.turn.request 开的轮次:本轮跑插件挂起的那条消息,promptText 不用。 */
  trigger?: { requestId: string };
}

/** 建会话 / 判定复用要用的输入(生成与指令执行共用;本轮输入、补发、开轮请求只属于生成)。 */
export type PiSessionInputs = Omit<PiGenerationContext, "promptText" | "images" | "trigger" | "onSteerBoundary">;

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
  const identity = { providerId: ctx.grant.providerId, providerName: ctx.grant.providerName };
  const outlets = requestLog
    ? { session: createModelOutlet(identity, requestLog), cacheWarm: createModelOutlet(identity, requestLog, "cache_warm") }
    : undefined;
  return createPiModelRuntime(mapping, ctx.credentialSource, outlets);
}

/** 会话装载完成后建对账器(不传 appendEntries = 不写)。送达失败报一次 warn。pending = 接着用的会话
 *  上一轮没交出的条目。 */
function entrySyncFor(
  manager: SessionManager,
  ctx: Pick<PiGenerationContext, "appendEntries" | "report">,
  pending?: ReadonlySet<string>,
): PiEntrySync | undefined {
  const { appendEntries } = ctx;
  if (!appendEntries) return undefined;
  return createPiEntrySync(
    manager,
    appendEntries,
    (error) =>
      ctx.report?.({
        domain: "pi-engine",
        severity: "warn",
        message: "工作区会话的引擎记录未能保存,下一轮这部分历史按界面内容重建(思考签名等引擎数据不保留)",
        detail: error instanceof Error ? error.message : String(error),
      }),
    pending,
  );
}

/** 复用判定的配置键:建会话时定下、之后不再读的输入,任何一项变了都重建。只留摘要(授权里有密钥)。 */
function configKeyOf(ctx: PiSessionInputs, extra: string): string {
  const material = JSON.stringify({
    grant: ctx.grant,
    reasoningLevel: ctx.reasoningLevel ?? null,
    cwd: ctx.cwd,
    workspace: ctx.workspaceTools ? { root: ctx.workspaceTools.root, shell: ctx.workspaceTools.shell ?? null } : null,
    tools: ctx.tools ?? [],
    wired: {
      credential: Boolean(ctx.credentialSource),
      log: Boolean(ctx.requestLog),
      callTool: Boolean(ctx.callTool),
      interaction: Boolean(ctx.interaction),
    },
    extra,
  });
  return createHash("sha256").update(material).digest("hex");
}

const unwired = (what: string) => Promise.reject(new Error(`${what}通道未接线(不在轮次之内)`));

/** 新建会话。每轮变化的接线都委托到 routes(见 session-host 头注)。 */
async function buildLiveSession(
  ctx: PiSessionInputs,
  manager: SessionManager,
  configKey: string | undefined,
  routes: PiTurnRoutes,
): Promise<PiLiveSession> {
  const mapped = mapGrantToPi(ctx.grant);
  if (!mapped.ok) throw new Error(`该模型无法在工作区引擎使用：${mapped.reason}`);
  const { runtime, model } = await createModelRuntimeFor(mapped.mapping, {
    grant: ctx.grant,
    ...(ctx.credentialSource ? { credentialSource: () => routes.credentialSource?.() ?? unwired("订阅凭据") } : {}),
    ...(ctx.requestLog ? { requestLog: (record) => routes.requestLog?.(record) } : {}),
  });

  const workspaceTools = ctx.workspaceTools;
  const builtinTools = workspaceTools
    ? createPiBuiltinTools({
        cwd: ctx.cwd,
        root: workspaceTools.root,
        shell: workspaceTools.shell,
        approve: (req) => routes.approveWorkspaceTool?.(req) ?? unwired("审批"),
      })
    : [];
  const callTool: PiAppToolCaller | undefined = ctx.callTool
    ? (call) => routes.callTool?.(call) ?? unwired(`应用工具 ${call.name} 的`)
    : undefined;
  const resources =
    typeof ctx.resources === "function" ? await ctx.resources((req) => routes.approvePluginTool?.(req) ?? unwired("审批")) : ctx.resources;
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: piAgentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    thinkingLevel: piThinkingLevelFor(ctx.reasoningLevel),
    // "builtin" 只关 pi 默认后端的内建工具;customTools 经 includeAllExtensionTools 全部激活
    // (agent-session.ts 的 includeAllExtensionTools + _refreshToolRegistry,§七-3 实证),同名即顶替内建定义。
    noTools: "builtin",
    excludeTools: workspaceTools ? excludedPiBuiltinToolNames(workspaceTools.shell) : [...allToolNames],
    customTools: [...builtinTools, ...createPiAppTools(ctx.tools ?? [], callTool)],
    // P4 资源统一:受控 ResourceLoader(技能白名单/AGENTS.md 边界过滤/appendSystemPrompt)
    // + 受控 SettingsManager(inMemory,封死 .pi/settings.json 注入面)。
    // 注意 sdk 只对自建 loader 调 reload,resources 在装配处已 reload 完毕。
    ...(resources ? { resourceLoader: resources.resourceLoader, settingsManager: resources.settingsManager } : {}),
  });

  // steering 一次吸收全部:与聊天引擎 steerBoundary 整批排水、Codex pending_input
  // split_off(0) 同语义——多条插话 = 多个 user 气泡 + 一个 ai_2,不按轮次逐条滴灌。
  session.agent.steeringMode = "all";
  applyPromptCachePolicy(session.agent, runtime, ctx.grant);

  // 工作区工具与应用工具的 details 都是我们打的标记;其余(插件工具)只按 content 映射。
  const markedToolNames = new Set([...builtinTools, ...(ctx.tools ?? [])].map((tool) => tool.name));
  const live = createPiLiveSession(
    { conversationId: ctx.conversationId, configKey, session, manager, runtime, model, markedToolNames, pluginEntries: resources?.plugins ?? [], routes },
    ctx.sessions?.host,
  );
  try {
    const interaction: PiPluginInteraction | undefined = ctx.interaction
      ? {
          dialog: (call) => routes.interaction?.dialog(call) ?? Promise.resolve({ cancelled: true }),
          dismiss: (requestId) => routes.interaction?.dismiss(requestId),
          show: (call) => routes.interaction?.show(call),
        }
      : undefined;
    // 插件的 session_start(状态重放)在首个请求之前;没有插件时是空操作。
    live.attachPlugins(await bindPiPluginSession(session, resources?.plugins ?? [], resources?.pluginPolicy ?? null, ctx.report, interaction));
    // 插件的 session_start 可能补登记工具,所以闸门核对放在绑定之后、首个请求之前。
    assertPiToolsGated(session);
  } catch (err) {
    await live.close();
    throw err;
  }
  return live;
}

/** 接着用活会话:配置键相同,且活会话与本轮视图重建出的会话模型可见内容逐条相同。返回本轮的消息 id →
 *  活会话条目 id;不能接着用时关掉它。 */
async function reuseLiveSession(
  ctx: PiSessionInputs,
  seeded: PiSessionFromView,
  configKey: string | undefined,
): Promise<{ live: PiLiveSession; entryIdsByMessageId: Map<string, string[]> } | undefined> {
  const live = ctx.sessions?.host.checkout(ctx.conversationId);
  if (!live) return undefined;
  const mapping = live.configKey === configKey ? matchLiveSession(live.manager, seeded.manager, live.lastSync?.undelivered() ?? new Set()) : null;
  if (!mapping) {
    await live.close();
    return undefined;
  }
  const entryIdsByMessageId = new Map(
    [...seeded.entryIdsByMessageId].map(([messageId, entryIds]) => [
      messageId,
      entryIds.flatMap((entryId) => {
        const liveId = mapping.get(entryId);
        return liveId ? [liveId] : [];
      }),
    ]),
  );
  return { live, entryIdsByMessageId };
}

/** 一次调用取到的会话:接着用的活会话,或按本次视图新建的。 */
interface AcquiredPiSession {
  live: PiLiveSession;
  manager: SessionManager;
  seeded: PiSessionFromView;
  entryIdsByMessageId: Map<string, string[]>;
  /** 本次调用开始前已有的条目(压缩捕获据此认新条目)。 */
  seededEntryIds: Set<string>;
  entrySync: PiEntrySync | undefined;
}

/** 由会话视图重建一份 inMemory 会话(零文件):新建时直接用它,有活会话时拿它比对。接线装进 routes,
 *  合成行计划随之定下。check 在复用判定之前调用(它失败时活会话不受影响)。 */
async function acquirePiSession(ctx: PiSessionInputs, check?: () => void): Promise<AcquiredPiSession> {
  const seeded = createPiSessionFromView({
    cwd: ctx.cwd,
    conversationId: ctx.conversationId,
    view: ctx.view,
    fallbackModelId: ctx.grant.modelId,
  });
  const configKey = ctx.sessions ? configKeyOf(ctx, ctx.sessions.key) : undefined;
  const routes: PiTurnRoutes = {
    credentialSource: ctx.credentialSource,
    requestLog: ctx.requestLog,
    approveWorkspaceTool: ctx.workspaceTools?.approve,
    approvePluginTool: ctx.approvePluginTool,
    callTool: ctx.callTool,
    interaction: ctx.interaction,
  };
  check?.();
  const reused = await reuseLiveSession(ctx, seeded, configKey);
  const manager = reused?.live.manager ?? seeded.manager;
  const entryIdsByMessageId = reused?.entryIdsByMessageId ?? seeded.entryIdsByMessageId;
  // 对账器建在新会话之前:插件在 session_start 里追加的条目也要交出。
  const seededEntryIds = new Set(manager.getEntries().map((entry) => entry.id));
  const entrySync = entrySyncFor(manager, ctx, reused?.live.lastSync?.undelivered());
  let live: PiLiveSession;
  if (reused) {
    live = reused.live;
    Object.assign(live.routes, routes);
  } else {
    live = await buildLiveSession(ctx, manager, configKey, routes);
  }
  live.synthetic = planSyntheticRows(manager, seeded.syntheticRows, (messageId) => entryIdsByMessageId.get(messageId));
  return { live, manager, seeded, entryIdsByMessageId, seededEntryIds, entrySync };
}

/** 调用收尾:清掉本次接线;没有会话宿主或本次不健康时关掉会话,否则交还复用。 */
async function releasePiSession(ctx: PiSessionInputs, acquired: AcquiredPiSession, healthy: boolean): Promise<void> {
  const { live, entrySync } = acquired;
  const sessions = ctx.sessions?.host;
  live.synthetic = EMPTY_SYNTHETIC_PLAN;
  clearTurnRoutes(live.routes);
  if (!sessions || !healthy) await live.close();
  // 收尾前最后一批(含中止、失败的轮次;它们不会被封存,装载时作废)。
  await entrySync?.flush();
  live.lastSync = entrySync;
  if (sessions && healthy) await sessions.checkin(live);
}

/** 流式增量之外的每个事件都是对账点。message_end 的落库在事件派发之后,那一条由下一个事件交出。 */
const isReconcilePoint = (type: string) => type !== "message_update" && type !== "tool_execution_update" && type !== "bash_execution_update";

/** 插件在这次调用里另开的会话(子代理),工具调用经本轮的工作区审批口判定(child-sessions)。 */
function childOwnerOf(ctx: PiSessionInputs): PiChildSessionOwner | undefined {
  const workspace = ctx.workspaceTools;
  return workspace ? { root: workspace.root, approve: workspace.approve } : undefined;
}

export function runPiGeneration(ctx: PiGenerationContext): Promise<PiGenerationResult> {
  return runAsPiChildOwner(childOwnerOf(ctx), () => generate(ctx));
}

async function generate(ctx: PiGenerationContext): Promise<PiGenerationResult> {
  if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  const sessions = ctx.sessions?.host;
  const triggered = ctx.trigger ? sessions?.takePendingTurn(ctx.conversationId, ctx.trigger.requestId) : undefined;
  const acquired = await acquirePiSession(ctx, () => {
    if (ctx.trigger && !triggered) throw new Error("插件请求的这一轮已失效(会话已被回收或删除)");
  });
  const { live, manager, seeded, entryIdsByMessageId, seededEntryIds, entrySync } = acquired;
  const { session } = live;

  const bridge = createPiEventBridge({
    report: ctx.report,
    appToolNames: live.markedToolNames,
    toolPlugin: (name) => pluginIdForTool(session.resourceLoader.getExtensions().extensions, live.pluginEntries, name),
    takeVeto: takePiPluginVeto,
  });
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) ctx.sink(generationEvent);
    if (isReconcilePoint(event.type)) void entrySync?.flush();
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
  let healthy = false;
  live.turnActive = true;
  try {
    // 应用没为它们开轮的挂起消息并进本轮(pi 的 nextTurn:随本轮起始消息一起进上下文)。
    for (const pending of sessions?.drainPendingTurns(ctx.conversationId) ?? []) {
      await live.sendCustomMessage(pending.message, { ...pending.options, deliverAs: "nextTurn" });
    }
    if (ctx.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const { model } = live;
    await runWithGoogleRequestLog(googleRequestLogContextFor(model.api, ctx.grant, ctx.requestLog), () =>
      triggered
        ? live.sendCustomMessage(triggered.message, triggered.options)
        : // expandPromptTemplates:false——用户消息逐字直达模型。pi 默认会把 "/" 开头的输入
          // 当模板/扩展命令拦截(agent-session.ts prompt() 的 expandPromptTemplates 分支),我们的会话 UX 不走 pi 命令面。
          session.prompt(ctx.promptText, {
            expandPromptTemplates: false,
            ...(ctx.images?.length ? { images: ctx.images } : {}),
          }),
    );
    healthy = true;
  } finally {
    live.turnActive = false;
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribeSteer?.();
    unsubscribe();
    await releasePiSession(ctx, acquired, healthy);
  }

  const capturedCompactions = captureRoundCompactions(manager, seededEntryIds, entryIdsByMessageId);

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

// ===== P5.7:插件指令 =====

export interface PiCommandContext extends PiSessionInputs {
  /** plugins/commands 的 piCommandId。 */
  commandId: string;
  args: string;
}

export interface PiCommandResult {
  /** 处理函数里 ctx.compact() 产生的压缩(切点映射同生成路径)。 */
  capturedCompactions: CapturedEngineCompaction[];
}

/** 在长驻会话上执行一条插件指令:与生成同一套取会话 / 复用判定 / 接线,但不 prompt——处理函数自己决定做什么。
 *  它要模型再答一轮(sendMessage 带 triggerTurn、sendUserMessage)时经会话宿主变成开轮请求(在应用的轮次之外);
 *  它调 ctx.compact() 时等压缩做完再返回。处理函数抛错以错误拒绝(错误文本带插件 id),会话照常留着复用。 */
export function runPiCommand(ctx: PiCommandContext): Promise<PiCommandResult> {
  return runAsPiChildOwner(childOwnerOf(ctx), () => runCommand(ctx));
}

async function runCommand(ctx: PiCommandContext): Promise<PiCommandResult> {
  if (ctx.signal?.aborted) throw new DOMException("Command cancelled", "AbortError");
  const acquired = await acquirePiSession(ctx);
  const { live, manager, entryIdsByMessageId, seededEntryIds, entrySync } = acquired;
  const { session } = live;
  // 引擎状态(压缩中等)照常经桥上报;指令不产生回答内容,其余事件丢弃。
  const bridge = createPiEventBridge({ report: ctx.report, appToolNames: live.markedToolNames });
  const unsubscribe = session.subscribe((event) => {
    for (const generationEvent of bridge.handle(event)) if (generationEvent.kind === "engine_status") ctx.sink(generationEvent);
    if (isReconcilePoint(event.type)) void entrySync?.flush();
  });
  const onAbort = () => {
    void session.abort();
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  let healthy = false;
  let failure: Error | undefined;
  try {
    const found = findPiPluginCommand(session.resourceLoader.getExtensions().extensions, live.pluginEntries, ctx.commandId);
    if (!found) throw new Error("该指令已不可用(插件已卸载或停用)");
    const { pluginId, command } = found;
    await runWithGoogleRequestLog(googleRequestLogContextFor(live.model.api, ctx.grant, ctx.requestLog), async () => {
      try {
        await runAsPiPlugin(pluginId, () => command.handler(ctx.args, session.extensionRunner.createCommandContext()));
      } catch (err) {
        failure = new Error(`插件 ${pluginId} 的指令 /${command.name} 出错:${err instanceof Error ? err.message : String(err)}`);
      }
      // ctx.compact() 不等完成就返回,而且压缩要过几个微任务才把会话标成「不空闲」:先让出一次,再等它(以及
      // 处理函数留下的其它运行)做完,压缩条目才能交出。
      await new Promise((resolve) => setTimeout(resolve, 0));
      await session.waitForIdle();
    });
    if (ctx.signal?.aborted) throw new DOMException("Command cancelled", "AbortError");
    healthy = true;
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    await releasePiSession(ctx, acquired, healthy);
  }
  if (failure) throw failure;
  return { capturedCompactions: captureRoundCompactions(manager, seededEntryIds, entryIdsByMessageId) };
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
  /** 插件的界面通道(生产 = host.interaction,绑本次 turnId)。不传 = 插件看到 pi 的空界面。 */
  interaction?: PiPluginInteraction;
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
    excludeTools: [...allToolNames],
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
  let pluginBinding: PiPluginSessionBinding | undefined;
  try {
    pluginBinding = await bindPiPluginSession(session, ctx.resources?.plugins ?? [], ctx.resources?.pluginPolicy ?? null, ctx.report, ctx.interaction);
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
    await pluginBinding?.shutdown();
    unsubscribe();
    session.dispose();
  }
}
