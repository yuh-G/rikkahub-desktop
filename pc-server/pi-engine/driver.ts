// pi-engine/driver.ts — pi 引擎的 EngineDriver 实现(P2.2,placement: "portable")
//
// 输入全部来自契约:TurnRequest.input / CompactRequest(模型授权、指令、工具规格、本轮输入)与
// EngineHost(会话视图、事件、工具调用、补发、订阅令牌、诊断)。本模块不读应用状态,所以能原样
// 搬进子进程(P2.6 跨进程冒烟)。会话视图如何装进 pi 会话见 session-view。
//
// 取消:应用调 abort(conversationId),驱动中止该会话登记的控制器(轮次或压缩,同会话不会
// 并存)。登记发生在 startTurn/compact 的同步前缀里,应用在调用之前挂好中止监听,所以从
// 调用开始到返回的任何中止都落在这一轮上。
//
// 同会话串行:pi 会话 id 取应用会话 id,前后两轮共用。旧轮 dispose 时 pi 按会话 id 释放会话级
// 资源(Codex WebSocket 连接等),落在已开始的新轮上会掐断它的在途连接。所以新一轮先等旧轮收尾
// (应用接管时已先中止旧轮),最多等 PREVIOUS_RUN_GRACE_MS,防旧轮卡死拖住新轮。
//
// 长驻会话(P5.6):生成轮跨轮复用活的 pi 会话(session-host;复用判定在 runner)。会话删除时应用调
// invalidate;手动压缩前先作废,压缩自己用一次性会话。引擎发起的轮次经 host.turn.request 请应用开轮,
// 开轮时 TurnInput.trigger 带回请求 id。
//
// 指令(P5.7):listCommands 读活会话的插件登记表,没有活会话时由 plugins/commands 单独加载一次插件(缓存)。
// runCommand 与生成同一套会话装配(同会话串行、长驻会话复用判定),在会话上直接调插件的处理函数,不开模型轮次。
// inspectPlugin(P7.2.5):插件页要的「这个插件登记了什么」,单独加载一次插件读出来(plugins/inspect),不建会话。
//
// 压缩的摘要模型回退在这里做:摘要模型映射不进 pi 时改用会话模型,并经 host.report 上报
// warn——公共压缩模型是偏好不是硬约束,压缩必须总能进行。

import type {
  CommandRunResult,
  CompactRequest,
  CompactResult,
  EngineDriver,
  EngineErrorReport,
  EngineHost,
  EnginePluginInspectionDto,
  EngineSessionView,
  ModelGrant,
  TurnInput,
  TurnRef,
  TurnRequest,
  TurnResult,
} from "../engines/contract";
import { piAgentDir } from "../foundation/paths";
import { bindPiAgentDir } from "./agent-dir";
import { PI_CAPABILITIES } from "./capabilities";
import { mapGrantToPi } from "./model-bridge";
import type { PiPluginInteraction } from "./plugins/ui-bridge";
import { createPiCommandCatalog } from "./plugins/commands";
import { inspectPiPlugin } from "./plugins/inspect";
import { createPiSessionResources } from "./resources";
import { MANUAL_COMPACT_KEEP_RECENT_TOKENS, runPiCommand, runPiCompaction, runPiGeneration, type PiSessionInputs } from "./runner";
import { createPiSessionHost } from "./session-host";

const MISSING_WORKSPACE = "pi 引擎被选中但请求未带工作区(路由判定与执行不一致)。";

const PREVIOUS_RUN_GRACE_MS = 10_000;

async function settledWithin(previous: Promise<void> | undefined, ms: number): Promise<void> {
  if (!previous) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([previous, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

/** 摘要模型:请求里的 summarizer 优先;pi 映射不进时回退会话模型并上报。 */
function summarizerGrant(req: CompactRequest, report: (report: EngineErrorReport) => void): ModelGrant {
  const summarizer = req.summarizer;
  if (!summarizer) return req.model;
  if (mapGrantToPi(summarizer).ok) return summarizer;
  report({
    domain: "provider",
    severity: "warn",
    message: `压缩模型 ${summarizer.displayName || summarizer.modelId} 无法在工作区引擎使用,本次压缩改用会话模型`,
    code: "compact_summarizer_fallback",
  });
  return req.model;
}

export function createPiDriver(host: EngineHost): EngineDriver {
  bindPiAgentDir();
  const running = new Map<string, AbortController>();
  /** 每会话最近一次运行的收尾(见头注「同会话串行」)。 */
  const lastRun = new Map<string, Promise<void>>();
  const sessions = createPiSessionHost({ onTurnRequest: (req) => host.turn.request({ engine: "pi", ...req }) });
  const commandCatalog = createPiCommandCatalog();

  /** 同会话已有登记时覆盖(旧轮已被应用中止);释放按控制器身份,旧轮收尾不会误删新登记。
   *  previous = 上一次运行的收尾,调用方在建 pi 会话之前等它。 */
  function register(conversationId: string): { signal: AbortSignal; previous: Promise<void> | undefined; release: () => void } {
    const controller = new AbortController();
    running.set(conversationId, controller);
    const previous = lastRun.get(conversationId);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    lastRun.set(conversationId, settled);
    return {
      signal: controller.signal,
      previous,
      release: () => {
        settle();
        if (running.get(conversationId) === controller) running.delete(conversationId);
        if (lastRun.get(conversationId) === settled) lastRun.delete(conversationId);
      },
    };
  }

  const report = (item: EngineErrorReport) => host.report(item);
  const credentialSourceFor = (turn: TurnRef, grant: ModelGrant) => () =>
    host.models.credential({ ...turn, providerId: grant.providerId });
  const interactionFor = (turn: TurnRef): PiPluginInteraction => ({
    dialog: (call) => host.interaction.dialog({ ...turn, ...call }),
    dismiss: (requestId) => host.interaction.dismiss({ ...turn, requestId }),
    show: (call) => host.interaction.show({ ...turn, ...call }),
  });

  /** 一次调用(生成 / 指令执行)的会话装配输入,全部来自契约。 */
  function sessionInputsFor(turn: TurnRef, input: TurnInput, view: EngineSessionView, signal: AbortSignal): PiSessionInputs {
    const { cwd, root, shell } = input.workspace!;
    return {
      grant: input.model,
      credentialSource: credentialSourceFor(turn, input.model),
      requestLog: (record) => host.models.log(turn, record),
      // 思考强度与聊天引擎同源(助手设置);pi 档位翻译见 model-bridge piThinkingLevelFor。
      reasoningLevel: input.reasoningLevel,
      conversationId: turn.conversationId,
      cwd,
      view,
      // 资源只在新建会话时装配;指令或插件清单变了即重建(配置键)。
      resources: (approvePluginTool) =>
        createPiSessionResources({
          cwd,
          root,
          instructions: input.instructions,
          plugins: input.plugins,
          appToolNames: input.tools.map((tool) => tool.name),
          approvePluginTool,
          report,
        }),
      sessions: { host: sessions, key: JSON.stringify({ instructions: input.instructions, plugins: input.plugins ?? [] }) },
      // 插件工具由 pi 执行,执行前回应用审批(类别 plugin,来源带插件 id)。
      approvePluginTool: ({ pluginId, ...call }) => host.permission.check({ ...turn, ...call, origin: { kind: "plugin", pluginId } }),
      // 工作区工具 = pi 内建工具 + 应用后端;执行前回应用审批(来源 engine,类别与对象来自 builtin-tools 的映射表)。
      workspaceTools: {
        root,
        ...(shell ? { shell } : {}),
        approve: (req) => host.permission.check({ ...turn, ...req, origin: { kind: "engine" } }),
      },
      tools: input.tools,
      callTool: (call) => host.tools.call({ ...turn, ...call }),
      report,
      interaction: interactionFor(turn),
      appendEntries: (entries) => host.session.append(turn, entries),
      sink: (event) => host.emit(turn, event),
      signal,
    };
  }

  return {
    kind: "pi",
    capabilities: PI_CAPABILITIES,

    async startTurn(req: TurnRequest): Promise<TurnResult> {
      const turn: TurnRef = { conversationId: req.conversationId, turnId: req.turnId };
      const run = register(req.conversationId);
      try {
        const input = req.input;
        if (!input) throw new Error("pi 驱动缺少 TurnInput(portable 驱动必须收完整输入)。");
        if (!input.workspace) throw new Error(MISSING_WORKSPACE);
        await settledWithin(run.previous, PREVIOUS_RUN_GRACE_MS);
        const view = await host.session.load(turn);
        const result = await runPiGeneration({
          ...sessionInputsFor(turn, input, view, run.signal),
          promptText: input.prompt.text,
          images: input.prompt.images,
          ...(input.trigger ? { trigger: { requestId: input.trigger.requestId } } : {}),
          onSteerBoundary: () => host.steer.take(turn),
        });
        return { text: result.text, stopReason: result.stopReason, compactions: result.capturedCompactions };
      } finally {
        run.release();
      }
    },

    async abort(conversationId: string): Promise<void> {
      running.get(conversationId)?.abort();
    },

    async compact(req: CompactRequest): Promise<CompactResult> {
      const turn: TurnRef = { conversationId: req.conversationId, turnId: req.turnId };
      const run = register(req.conversationId);
      try {
        if (!req.workspace) throw new Error(MISSING_WORKSPACE);
        const { cwd, root } = req.workspace;
        await settledWithin(run.previous, PREVIOUS_RUN_GRACE_MS);
        // 压缩用一次性会话;同一个 pi 会话 id 下不留长驻会话(压缩后视图也对不上它了)。
        await sessions.invalidate(req.conversationId);
        const view = await host.session.load(turn);
        const resources = await createPiSessionResources({
          cwd,
          root,
          instructions: req.instructions,
          plugins: req.plugins,
          // 手动压缩门槛/保留窗口调低(中文 chars/4 低估问题,rationale 见 runner.ts 常量)。
          compactionKeepRecentTokens: MANUAL_COMPACT_KEEP_RECENT_TOKENS,
          report,
        });
        const grant = summarizerGrant(req, report);
        const result = await runPiCompaction({
          grant,
          credentialSource: credentialSourceFor(turn, grant),
          requestLog: (record) => host.models.log(turn, record),
          // 压缩摘要与主会话同档(勿分叉)。
          reasoningLevel: req.reasoningLevel,
          conversationId: req.conversationId,
          cwd,
          view,
          resources,
          customInstructions: req.customInstructions,
          sink: (event) => host.emit(turn, event),
          report,
          interaction: interactionFor(turn),
          signal: run.signal,
        });
        return {
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          estimatedTokensAfter: result.estimatedTokensAfter,
          compaction: result.compaction,
          ...(result.native ? { native: result.native } : {}),
        };
      } finally {
        run.release();
      }
    },

    async invalidate(conversationId: string): Promise<void> {
      await sessions.invalidate(conversationId);
    },

    async listCommands(req) {
      if (!req.workspace) return [];
      const live = sessions.peek(req.conversationId);
      return commandCatalog.list(
        req.plugins,
        req.workspace.cwd,
        live ? { extensions: live.session.resourceLoader.getExtensions().extensions, entries: live.pluginEntries } : undefined,
      );
    },

    async inspectPlugin(req): Promise<EnginePluginInspectionDto> {
      return inspectPiPlugin(req.plugin, piAgentDir).catch((err: unknown) => ({
        tools: [],
        commands: [],
        mcpServers: [],
        errors: [err instanceof Error ? err.message : String(err)],
      }));
    },

    async runCommand(req): Promise<CommandRunResult> {
      const turn: TurnRef = { conversationId: req.conversationId, turnId: req.turnId };
      const run = register(req.conversationId);
      try {
        if (!req.input.workspace) throw new Error(MISSING_WORKSPACE);
        await settledWithin(run.previous, PREVIOUS_RUN_GRACE_MS);
        const view = await host.session.load(turn);
        const result = await runPiCommand({ ...sessionInputsFor(turn, req.input, view, run.signal), commandId: req.commandId, args: req.args });
        return { compactions: result.capturedCompactions };
      } finally {
        run.release();
      }
    },

    async dispose(): Promise<void> {
      for (const controller of running.values()) controller.abort();
      running.clear();
      commandCatalog.clear();
      await sessions.dispose();
    },
  };
}
