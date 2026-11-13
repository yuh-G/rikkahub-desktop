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
// 压缩的摘要模型回退在这里做:摘要模型映射不进 pi 时改用会话模型,并经 host.report 上报
// warn——公共压缩模型是偏好不是硬约束,压缩必须总能进行。

import type {
  CompactRequest,
  CompactResult,
  EngineCapabilities,
  EngineDriver,
  EngineErrorReport,
  EngineHost,
  ModelGrant,
  TurnRef,
  TurnRequest,
  TurnResult,
} from "../engines/contract";
import { mapGrantToPi } from "./model-bridge";
import { createPiSessionResources } from "./resources";
import { MANUAL_COMPACT_KEEP_RECENT_TOKENS, runPiCompaction, runPiGeneration } from "./runner";

const PI_CAPABILITIES: EngineCapabilities = {
  // 生成保持在跑,单个工具调用挂起等应用侧审批放行,不整批暂停重触发。
  resumeSemantics: "run-and-suspend",
  // runner 在 pi turn_end 调 host.steer.take,文本经 session.agent.steer() 入 pi steering 队列。
  steering: "boundary",
  // pi 原生 session.compact:压引擎记忆,界面历史不动。
  nativeCompaction: true,
  // 工作区引擎:请求必带 cwd/root(缺则以错误拒绝)。
  workspace: "required",
  placement: "portable",
};

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
  const running = new Map<string, AbortController>();
  /** 每会话最近一次运行的收尾(见头注「同会话串行」)。 */
  const lastRun = new Map<string, Promise<void>>();

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
        const { cwd, root } = input.workspace;
        await settledWithin(run.previous, PREVIOUS_RUN_GRACE_MS);
        const view = await host.session.load(turn);
        const resources = await createPiSessionResources({ cwd, root, instructions: input.instructions, report });
        const result = await runPiGeneration({
          grant: input.model,
          credentialSource: credentialSourceFor(turn, input.model),
          requestLog: (record) => host.models.log(turn, record),
          // 思考强度与聊天引擎同源(助手设置);pi 档位翻译见 model-bridge piThinkingLevelFor。
          reasoningLevel: input.reasoningLevel,
          conversationId: req.conversationId,
          cwd,
          view,
          promptText: input.prompt.text,
          images: input.prompt.images,
          resources,
          tools: input.tools,
          callTool: (call) => host.tools.call({ ...turn, ...call }),
          report,
          appendEntries: (entries) => host.session.append(turn, entries),
          sink: (event) => host.emit(turn, event),
          signal: run.signal,
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
        const view = await host.session.load(turn);
        const resources = await createPiSessionResources({
          cwd,
          root,
          instructions: req.instructions,
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
          signal: run.signal,
        });
        return {
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          estimatedTokensAfter: result.estimatedTokensAfter,
          compaction: result.compaction,
        };
      } finally {
        run.release();
      }
    },

    async dispose(): Promise<void> {
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}
