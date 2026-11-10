// engines/contract.ts — 应用↔引擎契约(方案 §5.3,P2.0 定稿)
//
// 两组接口:EngineDriver(应用→引擎,每个引擎实现一份)与 EngineHost(引擎→应用,应用实现
// 一份,交给每个驱动)。两条纪律:
//   1. 全部异步。单向通知(emit/report)返回 void,其余返回 Promise。
//   2. 全部载荷可 JSON 序列化:不传函数、活对象、类实例。进程内经 engines/loopback 直连
//      (测试里 strict 模式把每个载荷 JSON 往返一次,强制本条);进程外经 stdio 行帧。
// 本模块只有类型,不 import 任何具体引擎目录(engines/engine-agnostic-guard.test.ts 锁定)。
//
// 相对 §5.3 骨架的定稿细化:
// - 轮次身份 turnId:应用每轮生成一个,引擎回调全部带它。会话被接管时,旧轮迟到的事件
//   按 turnId 落回旧轮,不会写进新轮的消息(只带 conversationId 做不到这一点)。
// - 模型授权随请求下发(ModelGrant),引擎不回头拉。订阅凭据在授权里只是句柄,引擎每次请求前
//   经 host.models.credential 取应用刷新过的令牌——刷新权只在应用。
// - 取消是 driver.abort(conversationId, reason),不传 AbortSignal。
// - 活落点不进契约:事件只带 turnId,落到哪个消息节点由应用决定;补发分裂在 host.steer.take 里完成。
// - 应用工具一律经 host.tools.call:审批(含 ask_user 提问)、执行、结果实体化在应用侧一次完成,
//   执行中的部分输出由应用直接写进工具卡,不回绕引擎。
// - 暂不定义,到对应阶段再加:permission.check(P4b,引擎自己执行的工具)、指令列举与执行
//   (P5/P6)、界面请求(P5.4)、invalidate(P5.6 长驻会话)、请求日志通知(P2.5)。

import type { JsonValue, Message, OAuthFlowId, ToolOutputEntry } from "../foundation/types";
import type { AppErrorDomain, AppErrorSeverity } from "../foundation/types/dto";
import type { GenerationEvent } from "../inference-engine/events";

/** 引擎种类(开放枚举)。新增引擎 = 追加一个字面量 + 一个驱动 + 注册表一行。 */
export type EngineKind = "chat" | "pi" | "dsh" | "codex" | "claude-code" | (string & {});

/** 审批续跑语义:
 *  - "pause-resume":聊天引擎——待审批工具整批暂停生成,用户逐卡批准后重触发续跑。
 *  - "run-and-suspend":pi 引擎——生成保持在跑,单个工具调用挂起等审批门放行,不重触发整轮。 */
export type EngineResumeSemantics = "pause-resume" | "run-and-suspend";

/** steering(生成中补发的用户消息)送达能力:
 *  - "boundary":引擎在「即将构建下一次模型请求之前」调 host.steer.take,把返回文本作为 user
 *    消息喂给模型。应用在同一调用里完成数据层分裂(定格当前节点、落库补发、新开续写节点、换绑)。
 *  - "none":引擎没有注入位点。应用不排水,补发消息留在 FIFO 队列由收尾派发兜底。
 *  必须显式声明,忘了调用不会静默丢能力(契约测试锁每个 "boundary" 引擎的真实调用)。 */
export type EngineSteeringSupport = "boundary" | "none";

/** 声明式能力。应用据此路由与收尾,不按引擎种类特判。 */
export interface EngineCapabilities {
  readonly resumeSemantics: EngineResumeSemantics;
  readonly steering: EngineSteeringSupport;
  /** 有引擎原生压缩(压引擎记忆,界面历史不动)。没有则应用回落界面历史压缩。 */
  readonly nativeCompaction: boolean;
  /** portable = 必须能搬进独立进程:收完整的 TurnInput,只经 EngineHost 拿应用的东西。
   *  in-process-only = 应用自研的循环(聊天引擎),经进程内绑定直接读会话,不收 TurnInput。 */
  readonly placement: "in-process-only" | "portable";
}

/** 用户输入的模型可见形态(文档/OCR 已文本化,图片已物化为 base64)。图片随消息整体后置,
 *  不保留夹在文字中间的原位——与把附件作为独立内容块发送的协议行为等价。 */
export interface EngineImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PromptInput {
  /** 空串 + 无图片 = 没有可发送的内容。 */
  text: string;
  images: EngineImage[];
}

/** 会话级压缩记录(conversation.engineCompactions 的元素;引擎中立,跨引擎事实)。 */
export interface EngineCompactionRecord {
  /** 切点:从这条消息(含)起保留原文,之前的历史被 summary 取代。 */
  cutMessageId: string;
  summary: string;
  tokensBefore: number;
  createdAt?: string;
}

/** 引擎在一轮里产生的压缩(应用负责落 conversation.engineCompactions)。 */
export interface CapturedEngineCompaction {
  /** 切点消息 id。null = 切点落在本轮(本轮消息尚未入库),应用按「外收拢」落当前尾消息 id——
   *  只多保不少保,下一轮按「切点在场」自校验生效。 */
  cutMessageId: string | null;
  summary: string;
  tokensBefore: number;
}

/** 引擎会话视图(P3 前的取法:富化后的选中路径消息序列,内嵌在请求里;P3 改为 host 装载)。 */
export interface EngineHistory {
  /** 富化全序列(含合成行:时间提醒、聊天位注入),不含本轮新用户输入。 */
  messages: Message[];
  /** 合成行的 id(编码时照常编码,但挡在压缩切点映射与退化诊断之外)。 */
  syntheticIds: string[];
  compactions: EngineCompactionRecord[];
  /** USER 行的模型可见输入,按消息 id(附件物化读应用的文件表,所以在应用侧做)。
   *  缺项 = 该行没有可发送内容。 */
  userInputs: Record<string, PromptInput>;
}

/** 会话工作区(工作区会话才有)。cwd 是会话工作目录,root 是边界根。 */
export interface EngineWorkspace {
  cwd: string;
  root: string;
}

/** 系统提示词侧的应用资产。人设、记忆、搜索指引、注入面等文本由应用组装并在会话内冻结
 *  (同会话逐字节稳定);技能与全局 AGENTS.md 只给位置与内容,渲染格式归引擎。 */
export interface EngineInstructions {
  appendSystemPrompt: string[];
  /** 全局 AGENTS.md(应用级,住应用数据目录)。null = 不存在。 */
  globalAgentsFile: { path: string; content: string } | null;
  /** 技能库目录与本助手启用的技能名。 */
  skills: { dir: string; enabled: string[] };
}

// ---- 模型授权(§5.8) ----

export type ModelProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/** 凭据:API Key 直接给;订阅登录只给流程标识,令牌每次请求前经 host.models.credential 取
 *  (刷新只在应用侧发生)。flow 为 null = 订阅供应商未登记授权流程(引擎按映射失败处理)。 */
export type ModelCredential =
  | { kind: "api-key"; apiKey: string }
  | { kind: "subscription"; flow: OAuthFlowId | null };

/** 这一轮该用的模型。数值与请求头都是应用侧的最终值(上限走 requiredOutputCap 单源,请求头
 *  已含供应商/模型自定义头、主机特例与会话身份头),引擎只翻译成自己的请求选项,不二次加工。 */
export interface ModelGrant {
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  /** openai-completions 的非默认补全路径(用户自定义);缺省 = /chat/completions。 */
  completionsPath?: string;
  baseUrl: string;
  modelId: string;
  displayName: string;
  reasoning: boolean;
  imageInput: boolean;
  /** null = 查不到真值,引擎用自己的保守默认。 */
  limits: { contextWindow: number | null; maxTokens: number | null };
  headers: Record<string, string>;
  credential: ModelCredential;
}

export interface CredentialRequest {
  conversationId: string;
  /** 授权里的应用侧供应商 id。 */
  providerId: string;
  /** 要求的最短剩余有效期(毫秒);应用取它与 5 分钟的较大者,不足即在应用侧刷新。 */
  minValidityMs?: number;
}

/** 订阅凭据(pi-ai OAuthCredential 原样 JSON,对应用不透明)。 */
export type SubscriptionCredential = Record<string, JsonValue>;

// ---- 应用工具 ----

/** 应用提供给引擎的工具。group 区分工作区工具(引擎可按自己的约定补提示词摘要)与其它应用工具。 */
export interface AppToolSpec {
  name: string;
  description: string;
  /** JSON Schema。 */
  parameters: Record<string, JsonValue>;
  group: "workspace" | "general";
}

export interface AppToolCall {
  conversationId: string;
  turnId: string;
  toolCallId: string;
  name: string;
  args: Record<string, JsonValue>;
}

export type ToolContentBlock = { type: "text"; text: string } | EngineImage;

/** 审批(含 ask_user 提问)、执行、结果实体化都已在应用侧完成。被拒绝或执行失败时
 *  host.tools.call 以错误拒绝,错误文本即给模型的工具结果。 */
export interface AppToolResult {
  /** 模型可见的结果。 */
  content: ToolContentBlock[];
  /** 工具卡展示条目(已实体化);缺省 = 由 content 直接映射。 */
  display?: ToolOutputEntry[];
  /** 工作区工具的结构化细节(diff / exitCode 等,前端渲染契约)。 */
  details?: { tool: string; details: Record<string, JsonValue> };
}

// ---- 请求与结果 ----

/** portable 驱动一轮需要的全部输入(纯数据)。 */
export interface TurnInput {
  model: ModelGrant;
  /** 助手的推理强度原值(引擎自行翻译档位)。 */
  reasoningLevel: string | null;
  workspace: EngineWorkspace | null;
  instructions: EngineInstructions;
  history: EngineHistory;
  prompt: PromptInput;
  tools: AppToolSpec[];
}

export interface TurnRequest {
  conversationId: string;
  turnId: string;
  /** portable 驱动必有;in-process-only 驱动经进程内绑定读会话,不收。 */
  input?: TurnInput;
}

export interface TurnResult {
  /** 当前段的可见文本(补发分裂后只含最后一段)。 */
  text: string;
  stopReason: string | null;
  /** 本轮引擎自动压缩的产物(应用负责落库)。 */
  compactions: CapturedEngineCompaction[];
}

export interface CompactRequest {
  conversationId: string;
  turnId: string;
  /** 会话模型(压缩对象的视角)。 */
  model: ModelGrant;
  /** 执行摘要的模型;null = 用会话模型。引擎用不了时自行回退会话模型并上报 warn。 */
  summarizer: ModelGrant | null;
  reasoningLevel: string | null;
  workspace: EngineWorkspace | null;
  instructions: EngineInstructions;
  /** 只含真实行(合成行不进摘要)。 */
  history: EngineHistory;
  customInstructions: string;
}

export interface CompactResult {
  summary: string;
  tokensBefore: number;
  /** 引擎对压缩后上下文的估算(拿不到为 null,仅展示用)。 */
  estimatedTokensAfter: number | null;
  compaction: CapturedEngineCompaction;
}

export interface EngineErrorReport {
  domain: AppErrorDomain;
  severity: AppErrorSeverity;
  message: string;
  detail?: string;
  code?: string;
  params?: Record<string, string | number>;
}

/** 本轮回调的归属。会话被接管后,旧轮迟到的回调按 turnId 落回旧轮(应用侧丢弃)。 */
export interface TurnRef {
  conversationId: string;
  turnId: string;
}

// ---- 两组接口 ----

/** 应用 → 引擎:每个引擎实现一份。 */
export interface EngineDriver {
  readonly kind: EngineKind;
  readonly capabilities: EngineCapabilities;
  /** 一轮生成:事件经 host.emit 流出,结束后返回结果;上游失败以错误拒绝。
   *  被 abort 的轮次正常返回已生成部分(中止收尾由应用按自己的中止意图做)。 */
  startTurn(req: TurnRequest): Promise<TurnResult>;
  /** 中止该会话正在进行的轮次或压缩(没有则无事)。 */
  abort(conversationId: string, reason: string): Promise<void>;
  /** capabilities.nativeCompaction 为 true 时必须实现。 */
  compact?(req: CompactRequest): Promise<CompactResult>;
  dispose(): Promise<void>;
}

/** 引擎 → 应用:应用实现一份,交给每个驱动。 */
export interface EngineHost {
  /** 流式事件(GenerationEvent 是两种引擎共用的联合类型)。 */
  emit(turn: TurnRef, event: GenerationEvent): void;
  tools: { call(call: AppToolCall): Promise<AppToolResult> };
  /** 轮边界取「生成中补发」的消息文本;应用在同一调用里完成数据层分裂。空数组 = 无补发。 */
  steer: { take(turn: TurnRef): Promise<string[]> };
  models: { credential(req: CredentialRequest): Promise<SubscriptionCredential> };
  report(report: EngineErrorReport): void;
}
