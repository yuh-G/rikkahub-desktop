// pi-engine/assembly.ts — pi 工作区引擎的宿主侧装配(生成 / 压缩两个入口)。
//
// 定位:把「引擎无关输入包」(EngineRunContext / EngineCompactContext)翻译成 pi runner 的
// 输入——富化历史、压缩切点、会话资源、工具面、模型极限——再把产物(压缩记录)落回会话。
// 它是 pi adapter 的实现体,由引擎注册表(engines/index createEngineRegistry)直接接线;
// 编排器对 pi 零认知(T5 从 conversations/orchestrator 迁出,编排器只剩会话生命周期 +
// 队列 + 聊天引擎实现)。未来引擎照此形态各自提供 assembly,注册表一行接入。
//
// 本模块只装配不发请求:LLM 请求经 ctx.llmFetchFor 下发的通道(T4 组装点单源),
// 压缩记录读写走引擎中立的 conversations/engine-compactions。

import type { Assistant, Model, Provider } from "../foundation/types";
import type { EngineCompactionResult } from "../engines";
import type { PiCompactContext, PiRunContext } from "../engines/pi-adapter";
import type { GenerationEventSink } from "../inference-engine/events";
import { applyTemplateToMessage, encodableMessages, enrichMessages } from "../inference-engine/message-enrichment";
import { modelsDevCache } from "../inference-engine/providers";
import { contextWindowFor, requiredOutputCap } from "../model-providers/model-limits";
import { selectedConversationMessages } from "../conversations";
import { applyCapturedEngineCompactions, parseEngineCompactions } from "../conversations/engine-compactions";
import { reportError } from "../observability/app-errors";
import { MANUAL_COMPACT_KEEP_RECENT_TOKENS, runPiCompaction, runPiGeneration } from "./runner";
import { mapProviderModelToPi, type PiModelLimits } from "./model-bridge";
import { createPiWorkspaceTools } from "./workspace-tools";
import { createPiGeneralTools } from "./general-tools";
import { createPiSessionResources } from "./resources";
import { piPromptInputFromParts } from "./attachments";
import { effectiveEngineCompaction } from "./context-encoder";

/** pi 模型极限取值(P5 统计与压缩对齐):contextWindow 从 models.dev 查真实窗口
 *  (决定 pi 自动压缩阈值),maxTokens 走 requiredOutputCap —— 与聊天引擎 Claude 分支
 *  **同一个函数**,不是"同源口径"的口头约定。pi 的模型配置要求必须给出 maxTokens
 *  (它会恒发上限字段),所以这里同样属于"协议逼我给数"的场合。 */
function piModelLimitsFor(provider: Provider, model: Model, assistant: Assistant): PiModelLimits {
  return {
    contextWindow: contextWindowFor(modelsDevCache, provider, model.modelId),
    maxTokens: requiredOutputCap(modelsDevCache, provider, model.modelId, assistant.maxTokens),
  };
}

/** pi 引擎生成装配(P3 路由 + P4 资源统一 + P7 会话数据统一 + P8/P9 注入面统一)。
 *  输入是引擎无关输入包 + pi 专属 piRuntime(PiRunContext:adapter 在 matches() 判定后透传)。
 *  - prompt 输入取末 USER 节点选中消息(P4 附件面:文档/OCR 文本化与聊天引擎同母本,
 *    图片走 pi 原生 images 通道);prompt 文本经消息模板渲染(四件套之一);
 *  - 引擎上下文 = 编码器从富化后的选中路径历史(不含本轮 prompt 消息)确定性重建,
 *    压缩记录从 conversation.engineCompactions 进同一灌注——重新生成/编辑重发/分支切换
 *    天然生效(UI 选中路径就是引擎记忆,所见即所记);
 *  - 消息富化 = enrichMessages(四件套共享层):模板/时间提醒/lorebook+模式注入/
 *    窗口化(滞回截断 ∨ 压缩切点锚,P9)——聊天位注入/时间提醒随富化全序列(含
 *    合成行)灌进 pi 引擎,与聊天引擎逐字同生效;合成行由 syntheticIds 标出,编码器
 *    挡在切点映射/退化诊断外;系统位注入经 appendSystemPrompt 进 pi 系统面;
 *  - 工具面 = 七个工作区工具 + 通用工具/MCP 桥(P4),审批全部内化在工具 execute;
 *  - 资源面 = createPiSessionResources(技能白名单/AGENTS.md 边界过滤/人设+记忆冻结
 *    appendSystemPrompt/受控 settings)。 */
export async function runPiWorkspaceGeneration(
  ctx: PiRunContext,
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<string> {
  const { conversation, target, assistant, provider, model } = ctx;
  const runtime = ctx.piRuntime;
  if (!runtime) {
    // 路由不变式:resolveEngine 选中 pi 时 matches() 已确认工作区可用。此处为防御兜底
    // (adapter WeakMap 透传被回收的极端情况)——不可达于正常路径,报错好过静默走错引擎。
    throw new Error("pi 引擎被选中但工作区运行时不可用(路由判定与执行不一致)。");
  }
  const lastUserNode = [...conversation.messages]
    .reverse()
    .find((node) => (node.messages[node.selectIndex] ?? node.messages[0])?.role === "USER");
  const promptMessage = lastUserNode ? (lastUserNode.messages[lastUserNode.selectIndex] ?? lastUserNode.messages[0]) : null;
  // prompt 文本先经消息模板渲染(与历史消息同一富化口径),再走附件文本化。
  const template = assistant.messageTemplate?.trim() || "{{ message }}";
  const templatedPromptParts = promptMessage
    ? applyTemplateToMessage(promptMessage, template, "user", assistant, model)
    : [];
  const promptInput = promptMessage
    ? piPromptInputFromParts(templatedPromptParts, model)
    : { text: "", images: [] };
  if (!promptInput.text && !promptInput.images.length) {
    // 无文本且无图片输入直接走失败分支给出人话。
    throw new Error("工作区会话缺少可发送的用户消息内容,无法驱动工作区引擎。");
  }

  // 四件套富化(P9 灌注统一):历史消息(不含本轮 prompt)经共享层裁决;压缩切点
  // (effectiveEngineCompaction 单源判定)作为富化窗口锚——注入行/提醒恒在窗口内、恒在
  // 切点之后:既进模型视野,又永不落进被摘要吸收的旧历史。富化全序列(含合成行)
  // 进引擎,每轮从 DB 原文重新裁决,DB 零沉淀。
  const historySource = selectedConversationMessages(conversation).filter((msg) => msg.id !== promptMessage?.id);
  const compactionRecords = parseEngineCompactions(conversation.engineCompactions);
  const cut = effectiveEngineCompaction(compactionRecords, historySource, model);
  const enriched = enrichMessages(historySource, {
    conversation,
    assistant,
    model,
    windowStartMessageId: cut?.cutMessageId,
  });

  // 系统位注入(before/after_system_prompt)经 appendSystemPrompt 进 pi 系统面——
  // 与人设/记忆/搜索指引同一插槽,位置在 pi Guidelines 之后、project_context 之前。
  const systemInjection = [enriched.systemInjectionBefore, enriched.systemInjectionAfter].filter(Boolean).join("\n");
  const resources = await createPiSessionResources({
    conversation,
    assistant,
    model,
    cwd: runtime.cwd,
    root: runtime.root,
    extraAppendSystemPrompt: systemInjection ? [systemInjection] : undefined,
  });

  const result = await runPiGeneration({
    provider,
    model,
    // LLM 请求通道工厂(T4 组装点单源):SDK 内部每条请求经此出口;runner 以自身 provider 取通道。
    llmFetchFor: ctx.llmFetchFor,
    modelLimits: piModelLimitsFor(provider, model, assistant),
    // 思考强度与聊天引擎同源(助手设置);pi 档位翻译见 model-bridge piThinkingLevelFor。
    reasoningLevel: assistant.reasoningLevel,
    conversationId: conversation.id,
    cwd: runtime.cwd,
    history: enriched.messages,
    syntheticIds: enriched.syntheticIds,
    compactions: compactionRecords,
    promptText: promptInput.text,
    images: promptInput.images,
    resources,
    tools: [
      ...createPiWorkspaceTools({ conversation, assistant, sink }),
      ...createPiGeneralTools({ conversation, assistant, sink, target, model }),
    ],
    sink,
    signal,
    // steering 轮边界(用户问题②):编排层同一回调直通 pi runner,在 pi turn_end 同步
    // 调用(落库/队列联动/分裂在编排层 steerBoundary,runner 只拿文本喂 session.steer)。
    onSteerBoundary: ctx.onSteerBoundary,
  });
  applyCapturedEngineCompactions(conversation, result.capturedCompactions);
  return result.text;
}

/** pi 引擎压缩装配(P5 原生 compaction + P7 产物落 engineCompactions)。路由判定(工作区
 *  可用)已由 adapter.matches() 承担,本函数只管驱动;engine_status 经调用方注入的 sink
 *  直通,广播与终局清条不在此层。
 *  压缩的对象是"模型实际看到的消息":与生成路径同一富化裁决(模板/提醒/注入),
 *  但合成消息经 encodableMessages 剥回纯真实行(P9)——手动压缩是用户策展行为,
 *  摘要只覆盖真实对话;注入是配置不是对话,时间提醒只描述节奏,均不进摘要。
 *  窗口锚照常生效:切点前的历史已被上一轮摘要吸收,压缩对象从切点起即可。 */
export async function runPiWorkspaceCompaction(
  ctx: PiCompactContext,
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<EngineCompactionResult> {
  const { conversation, assistant } = ctx;
  const runtime = ctx.piRuntime;
  if (!runtime) {
    // 与 runPiWorkspaceGeneration 同一路由不变式防御——不可达于正常路径。
    throw new Error("pi 引擎被选中但工作区运行时不可用(路由判定与执行不一致)。");
  }
  const compactionRecords = parseEngineCompactions(conversation.engineCompactions);
  const cut = effectiveEngineCompaction(compactionRecords, selectedConversationMessages(conversation), ctx.model);
  const enriched = enrichMessages(selectedConversationMessages(conversation), {
    conversation,
    assistant,
    model: ctx.model,
    windowStartMessageId: cut?.cutMessageId,
  });
  const history = encodableMessages(enriched.messages, enriched.syntheticIds);
  const systemInjection = [enriched.systemInjectionBefore, enriched.systemInjectionAfter].filter(Boolean).join("\n");
  const resources = await createPiSessionResources({
    conversation,
    assistant,
    model: ctx.model,
    cwd: runtime.cwd,
    root: runtime.root,
    extraAppendSystemPrompt: systemInjection ? [systemInjection] : undefined,
    // 手动压缩门槛/保留窗口调低(中文 chars/4 低估问题,rationale 见 runner.ts 常量)。
    compactionKeepRecentTokens: MANUAL_COMPACT_KEEP_RECENT_TOKENS,
  });
  // 摘要模型:公共压缩模型优先(ctx.summarizer,装配点已决策),pi 映射不进(自定义
  // 补全路径的 openai 型服务商等)则回退会话模型——公共设置是偏好不是硬约束,
  // 压缩必须总能进行,回退留 warn 让用户知情。注意窗口锚定/富化裁决(上方 cut/
  // enriched)仍按 ctx.model:压缩对象是"会话模型实际看到的消息",与生成路径同一
  // 视角,勿随摘要模型漂移。
  let summarizer = ctx.summarizer;
  if (summarizer.model.id !== ctx.model.id && !mapProviderModelToPi(summarizer.provider, summarizer.model).ok) {
    reportError(
      "provider",
      "warn",
      `压缩模型 ${summarizer.model.displayName || summarizer.model.modelId} 无法在工作区引擎使用,本次压缩改用会话模型`,
      undefined,
      "compact_summarizer_fallback",
    );
    summarizer = { provider: ctx.provider, model: ctx.model };
  }
  const result = await runPiCompaction({
    provider: summarizer.provider,
    model: summarizer.model,
    // 以回退后的最终供应商取通道(runner 内 ctx.llmFetchFor(ctx.provider)):compaction 用途
    // 不挂预热捕获,日志归属恒与真实请求一致(T4 工厂形态的存在理由)。
    llmFetchFor: ctx.llmFetchFor,
    modelLimits: piModelLimitsFor(summarizer.provider, summarizer.model, assistant),
    reasoningLevel: assistant.reasoningLevel,
    conversationId: conversation.id,
    cwd: runtime.cwd,
    history,
    compactions: compactionRecords,
    resources,
    customInstructions: ctx.customInstructions,
    signal,
    sink,
  });
  // 产物落库是引擎实现的义务——与生成路径的压缩捕获同一落点、同一 helper。
  applyCapturedEngineCompactions(conversation, [result.compaction]);
  return result;
}
