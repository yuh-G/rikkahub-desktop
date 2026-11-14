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
// - 会话存储(§5.4):引擎经 host.session.load 取视图(富化后的选中路径 + 每项的有效原生条目),
//   经 host.session.append 追加原生条目。锚定(当前落点)与封存都在应用侧:封存的摘要必须取应用
//   收尾(输出变换等)之后的中立内容,而收尾发生在引擎的轮次结束之后,所以封存不进契约。
// - 应用工具一律经 host.tools.call:审批(含 ask_user 提问)、执行、结果实体化在应用侧一次完成,
//   执行中的部分输出由应用直接写进工具卡,不回绕引擎。
// - 模型请求日志:引擎把请求交给引擎侧的模型出口(engines/model-outlet,带显式供应商身份的
//   fetch),出口经 host.models.log 把每条请求的记录送回应用。fetch 本身不过契约(函数不可序列化),
//   所以引擎搬进子进程后日志照常。
// - 引擎自己执行的工具(插件工具 P5.4;引擎自带的工作区工具 P4b)经 host.permission.check 过应用审批。
// - 插件的界面请求(方案 §5.11,P5.5)分两条:对话框经 host.interaction.dialog 请求-应答(取消即答案,
//   不以错误拒绝;引擎侧先放弃时经 dismiss 收起);通知 / 状态条目 / 挂件 / 进行中提示经 host.interaction.show
//   单向通知(瞬态,不落库)。
// - 暂不定义,到对应阶段再加:指令列举与执行(P5.7)、invalidate(P5.6 长驻会话)。

import type { JsonValue, Message, OAuthFlowId, ToolOutputEntry } from "../foundation/types";
import type { AppErrorDomain, AppErrorSeverity } from "../foundation/types/dto";
import type { GenerationEvent } from "../inference-engine/events";
import type { PermissionTarget, ToolCategory } from "../tools/permission";

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
  /** 路由依据:required = 只接管工作区可用的会话(请求必带 workspace);none = 不用工作区。
   *  会话工作区可用 → 首个 required 的驱动,否则 → 首个 none 的驱动。 */
  readonly workspace: "required" | "none";
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

// ---- 会话存储(§5.4) ----

/** 引擎原生条目(应用只存取不解释 payload)。format 是引擎自定的格式版本;entryId 是条目自身的
 *  id(可空:DSH 以序号为身份),同会话同引擎内唯一,重复追加被跳过——对账可以整批重放。 */
export interface EngineEntryInput {
  format: string;
  entryId?: string | null;
  payload: JsonValue;
}

export interface EngineEntry {
  /** 会话内追加序号(跨锚定递增)。 */
  seq: number;
  format: string;
  entryId: string | null;
  payload: JsonValue;
}

/** 会话视图的一项:选中路径上的一条中立消息。 */
export interface EngineSessionItem {
  /** 富化后的消息(模板已渲染)。 */
  message: Message;
  /** 合成行(时间提醒、聊天位注入):照常编码,但挡在压缩切点映射与退化诊断之外;不会有原生条目。 */
  synthetic: boolean;
  /** USER 行的模型可见输入(附件物化读应用的文件表,所以在应用侧做)。缺省 = 该行没有可发送内容。 */
  input?: PromptInput;
  /** 本引擎锚定在这条消息上的原生条目(seq 升序)。只在条目已封存、且消息的引擎可见内容与封存时
   *  一致时给出;缺省 = 由中立内容回退编码(编辑过、别的引擎生成、老数据、生成中崩溃未封存)。 */
  native?: EngineEntry[];
}

/** 引擎会话视图(host.session.load)。复用粒度由驱动定:逐项取用,或只取从头起的最长有效前缀。 */
export interface EngineSessionView {
  /** 按选中路径排列(窗口化后),不含本轮新用户输入。 */
  items: EngineSessionItem[];
  compactions: EngineCompactionRecord[];
}

/** 会话工作区(工作区会话才有)。cwd 是会话工作目录,root 是边界根。 */
export interface EngineWorkspace {
  cwd: string;
  root: string;
  /** 本机可用的 bash(应用探测:用户指定路径 → 已知位置 → 内嵌 bash 兜底)。缺省 = 没有可用的 bash。 */
  shell?: string;
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

/** 本轮要加载的引擎插件。id 由应用给(审计、否决署名、审批来源都用它),path 是插件在本机的
 *  位置(入口文件或包目录)。空数组 = 不加载任何插件。 */
export interface EnginePlugin {
  id: string;
  path: string;
  /** 用户手动停用了这个插件的工具调用钩子(行为裁决的兜底开关,方案 §5.5 D7;P5.8 起由插件记录给出)。
   *  缺省 = 启用。 */
  toolCallHookDisabled?: boolean;
}

// ---- 模型授权(§5.8) ----

export type ModelProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/** 凭据:API Key 直接给;订阅登录只给流程标识,令牌每次请求前经 host.models.credential 取
 *  (刷新只在应用侧发生)。flow 为 null = 订阅供应商未登记授权流程(引擎按映射失败处理);
 *  signedIn 是本轮开始时的登录状态(未登录时引擎不去要令牌,按「无凭据」报错)。 */
export type ModelCredential =
  | { kind: "api-key"; apiKey: string }
  | { kind: "subscription"; flow: OAuthFlowId | null; signedIn: boolean };

/** 提示缓存策略(应用按供应商设置决定,引擎翻译成自己的请求选项)。
 *  enabled=false:请求不带任何缓存标记、缓存键。retention:"short" = 服务端默认保留期
 *  (Anthropic 5 分钟),"long" = 用户选的长保留(Anthropic 1 小时)。 */
export interface PromptCachePolicy {
  enabled: boolean;
  retention: "short" | "long";
}

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
  promptCache: PromptCachePolicy;
  /** 应用身份 User-Agent(设置 → 网络 的自定义值,否则品牌默认)。引擎的模型请求以它为 UA;
   *  订阅通道的客户端身份若由引擎内建的供应商定义维护(部分通道只对特定客户端开放),
   *  引擎保留通道身份。headers 里显式的 User-Agent 优先于它。 */
  userAgent: string;
}

export interface CredentialRequest {
  conversationId: string;
  /** 发起请求的轮次(应用按它找本轮授权涉及的供应商快照)。 */
  turnId: string;
  /** 授权里的应用侧供应商 id。 */
  providerId: string;
  /** 要求的最短剩余有效期(毫秒);应用取它与 5 分钟的较大者,不足即在应用侧刷新。 */
  minValidityMs?: number;
}

/** 引擎经模型出口(engines/model-outlet)发出的一条模型请求,应用记入请求日志。
 *  响应头到手即记(durationMs = 到响应头的时间),流式响应体不读;非 2xx 带截断的错误体;
 *  网络失败 status 为 0。凭据脱敏归应用。 */
export interface ModelRequestRecord {
  providerId: string;
  providerName: string;
  url: string;
  method: string;
  ok: boolean;
  status: number;
  durationMs: number;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  error?: string;
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

/** 引擎自己执行的工具执行前的应用审批。两种来源:插件工具(审批卡与会话级「总是允许」按插件认领);
 *  引擎自带的工具(pi 的 read / bash 等),类别与对象由引擎按自己的映射表给出,路径是引擎实际要
 *  操作的绝对路径——应用只按类别与对象判定,不认引擎的工具名。 */
export interface PermissionCheck {
  conversationId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  origin: { kind: "plugin"; pluginId: string } | { kind: "engine" };
  /** 引擎自带工具必带;插件工具恒为 plugin,不必带。 */
  category?: ToolCategory;
  /** 引擎自带工具必带(没有对象时为空对象)。 */
  target?: PermissionTarget;
  args: Record<string, JsonValue>;
}

/** 放行结果。scope 是这次调用的放行范围:default = 写入只许落在工作区边界内(按真实路径校验,软链
 *  逃逸也拦得住)、危险命令不执行;unrestricted = 不设这两道限制(用户在审批卡上批准了这次调用,
 *  或档位是完全访问)。插件工具恒为 default。 */
export interface PermissionGrant {
  scope: "default" | "unrestricted";
}

// ---- 界面请求(§5.11) ----

/** 需要用户回答的对话框。select 的答案可以不在 options 里(插件自己约定自由输入的解读)。 */
export type EngineDialogRequest =
  | { kind: "select"; title: string; options: string[] }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "input"; title: string; placeholder?: string };

export interface EngineDialogCall extends TurnRef {
  /** 引擎生成,本会话内唯一。 */
  requestId: string;
  /** 发起方插件 id;认领不到时为空串。 */
  source: string;
  request: EngineDialogRequest;
}

/** select / input 的答案是字符串,confirm 是布尔。 */
export type EngineDialogAnswer = { cancelled: true } | { cancelled: false; value: string | boolean };

/** 引擎侧先放弃了对话框(插件给的超时到了、插件自己取消),应用收起它。 */
export interface EngineDialogDismiss extends TurnRef {
  requestId: string;
}

/** 瞬态界面(不落库)。status / widget 按 (来源, key) 覆盖,text / lines 为 null 即清除;working 是生成中的进行提示。 */
export type EngineUiNotice =
  | { kind: "notify"; message: string; level: "info" | "warning" | "error" }
  | { kind: "status"; key: string; text: string | null }
  | { kind: "widget"; key: string; lines: string[] | null }
  | { kind: "working"; text: string | null };

export interface EngineUiNoticeCall extends TurnRef {
  source: string;
  notice: EngineUiNotice;
}

// ---- 请求与结果 ----

/** portable 驱动一轮需要的全部输入(纯数据)。 */
export interface TurnInput {
  model: ModelGrant;
  /** 助手的推理强度原值(引擎自行翻译档位)。 */
  reasoningLevel: string | null;
  workspace: EngineWorkspace | null;
  instructions: EngineInstructions;
  plugins: EnginePlugin[];
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
  /** 与生成同一套插件(插件能介入压缩,也会读写压缩前后的会话)。 */
  plugins: EnginePlugin[];
  customInstructions: string;
}

export interface CompactResult {
  summary: string;
  tokensBefore: number;
  /** 引擎对压缩后上下文的估算(拿不到为 null,仅展示用)。 */
  estimatedTokensAfter: number | null;
  compaction: CapturedEngineCompaction;
  /** 引擎的原生压缩条目(可选)。压缩调用不经 session.append:应用落压缩记录的同时把它锚定到尾消息
   *  并当场封存,之后随视图交回,由引擎与压缩记录配对取用。 */
  native?: EngineEntryInput;
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
  session: {
    /** 本次调用的会话视图。压缩调用的视图只含真实行(合成行不进摘要)。 */
    load(turn: TurnRef): Promise<EngineSessionView>;
    /** 追加原生条目,锚定到应用的当前落点消息。压缩调用不接收(以错误拒绝;原生压缩条目随
     *  CompactResult.native 交回)。 */
    append(turn: TurnRef, entries: EngineEntryInput[]): Promise<void>;
  };
  tools: { call(call: AppToolCall): Promise<AppToolResult> };
  /** 放行时返回放行结果;用户拒绝或中止时以错误拒绝,错误文本即给模型的工具结果(与 tools.call 同口径)。 */
  permission: { check(req: PermissionCheck): Promise<PermissionGrant> };
  interaction: {
    /** 插件对话框。用户取消、会话中止、轮次已结束都返回 { cancelled: true }(不以错误拒绝)。
     *  插件给的超时与取消信号由引擎侧处理:到时按取消回答插件,再经 dismiss 让应用收起。 */
    dialog(call: EngineDialogCall): Promise<EngineDialogAnswer>;
    /** 单向通知。 */
    dismiss(call: EngineDialogDismiss): void;
    /** 单向通知:瞬态界面。轮次结束后迟到的丢弃;轮次结束时该轮设置的状态条目 / 挂件 / 进行中提示随之清除。 */
    show(call: EngineUiNoticeCall): void;
  };
  /** 轮边界取「生成中补发」的消息文本;应用在同一调用里完成数据层分裂。空数组 = 无补发。 */
  steer: { take(turn: TurnRef): Promise<string[]> };
  models: {
    credential(req: CredentialRequest): Promise<SubscriptionCredential>;
    /** 单向通知:一条模型请求的日志(引擎侧出口记录,应用落请求日志)。 */
    log(turn: TurnRef, record: ModelRequestRecord): void;
  };
  report(report: EngineErrorReport): void;
}
