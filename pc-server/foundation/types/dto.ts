// foundation/types/dto.ts — 线上契约 DTO 单一声明源(FE-P1-2 批2)。
// 权威即后端:形状尽量从领域模型派生(Omit 交叉),领域类型演进时 DTO 自动跟随;
// 与领域模型的有意分歧只有 Message.annotations/usage(领域层硬化收官前仍以 JsonValue
// 承载,线上契约在 DTO 层收窄为真实产出形状),显式写在 Omit 里。
// 前端 web-ui/app/types/dto.ts 只做 type-only re-export;字段增删属冻结契约变更。

import type { Conversation, Message, MessageNode } from "./index";

// ── 消息级线上明细类型 ──────────────────────────────────────────────

/** 搜索工具产出的 url_citation 注释(search/index.ts 从 provider 响应过滤后写入)。 */
export type UrlCitationAnnotation = {
  type: "url_citation";
  title: string;
  url: string;
};

/** R7-2:模型调用失败的结构化标记(orchestrator catch 落在失败消息上)。前端错误横幅
 *  由它驱动,取代对正文的关键词正则匹配(正常讨论 HTTP 状态码/超时的内容不再误报)。 */
export type ModelCallErrorAnnotation = {
  type: "model_call_error";
  message: string;
};

/** 压缩发生点标记:压缩完成时打在"当时的最新一条消息"上(对话模式 auxiliary.ts /
 *  工作区 orchestrator applyCapturedEngineCompactions)。前端据此在该消息下方渲染
 *  "上下文已压缩"分割线——锚定用户发起压缩的位置,线上的会话已被压缩处理。
 *  PC 特有注解,安卓导出时过滤(backup/export.ts PC_ONLY_ANNOTATION_TYPES)。 */
export type CompactionBoundaryAnnotation = {
  type: "compaction_boundary";
};

/** 注释判别联合(对齐安卓 UIMessageAnnotation)。 */
export type UIMessageAnnotation = UrlCitationAnnotation | ModelCallErrorAnnotation | CompactionBoundaryAnnotation;

/** 专题3 批4:PC 注解判别符注册表(联合类型的运行时镜像)。UIMessageAnnotation 新增
 *  成员而不登记于此 = 编译失败(下方双向断言);登记后 android-contract-sync.test.ts
 *  会强制声明其安卓兼容性(安卓已知类型 or 导出过滤黑名单)。这样"新功能忘了惦记
 *  备份契约"会在编译/测试期爆炸,而不是在用户导入 APP 时爆炸。 */
export const PC_MESSAGE_ANNOTATION_TYPES = ["url_citation", "model_call_error", "compaction_boundary"] as const;
type AssertTrue<T extends true> = T;
type MutuallyEqual<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export type _AnnotationRegistryComplete = AssertTrue<
  MutuallyEqual<(typeof PC_MESSAGE_ANNOTATION_TYPES)[number], UIMessageAnnotation["type"]>
>;

/** token 用量:inference-engine 三家 provider 归一化后的统一形状(appendUsageFromRaw 等)。 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** true = 本地字数折算的估算值(厂商未回报 usage,见 conversations/helpers.ts ensureUsage);
   *  统计页命中率分母与前端上下文用量条均排除估算记录。 */
  estimated?: boolean;
  /** 模型最大上下文窗口(models.dev 目录查得);null = 未知/无匹配,缺省 = 尚未回填。 */
  contextLimit?: number | null;
  /** 纯生成耗时(毫秒,各轮"发请求→流读完"累计,不含轮间工具执行/审批等待;流式工具
   *  循环骨架累计)。统计行 token/s 的分母——用全程墙钟会被工具执行时间稀释(内测
   *  反馈)。缺省(旧数据/工作区 pi 路径)时前端回退全程时长。 */
  generationMs?: number;
};

// ── 会话/消息 DTO ──────────────────────────────────────────────────

/** 消息线上形状 = 领域 Message 原样出线,仅 annotations/usage 收窄(见文件头)。 */
export type MessageDto = Omit<Message, "annotations" | "usage"> & {
  annotations: UIMessageAnnotation[];
  usage: TokenUsage | null;
};

export type MessageNodeDto = Omit<MessageNode, "messages"> & {
  messages: MessageDto[];
};

/** 消息发送队列的线上快照项(生成中补发排队;preview/hasAttachments 由后端派生,前端直接渲染)。 */
export type MessageQueueItemDto = {
  id: string;
  preview: string;
  hasAttachments: boolean;
  createdAt: number;
};

/** 消息发送队列线上快照。纯内存态(不落库),随会话 SSE 快照直通;队空 = null(前端隐藏面板)。
 *  held:队列停摆原因——failed(上一条生成失败自动暂停,错误恢复语境)/ interrupted(用户主动
 *  停止后的冻结,中性提示)/ null(正常排队,当前回复结束后自动依次发送)。恢复动作同为 resume。 */
export type MessageQueueSnapshotDto = {
  items: MessageQueueItemDto[];
  held: "failed" | "interrupted" | null;
} | null;

/** 会话详情:GET conversations/:id 响应与会话 SSE snapshot 载荷。
 *  I-2(专题2)窗口化:快照可能只携带最近若干节点,messages[0] 的绝对节点下标为
 *  nodesOffset(缺省/0 = 从头完整);nodeStamps 为**全部**节点的内容戳清单(与绝对
 *  下标对齐),客户端据此对已加载的更早节点做可验证前缀合并。语义见
 *  api/snapshot-window.ts。 */
export type ConversationDto = Omit<Conversation, "messages"> & {
  messages: MessageNodeDto[];
  isGenerating: boolean;
  nodesOffset?: number;
  nodeStamps?: string[];
  /** 消息发送队列快照(瞬态,内存态)。生成中补发排队的面板数据源;队空为 null。 */
  messageQueue?: MessageQueueSnapshotDto;
};

/** GET conversations/:id/nodes 响应:窗口化快照的向上翻页分片(专题2 I-2)。
 *  nodes 为绝对下标 [offset, offset+nodes.length) 的连续节点,stamps 一一对应。 */
export type ConversationNodesPageDto = {
  nodes: MessageNodeDto[];
  stamps: string[];
  offset: number;
  updateAt: number;
};

/** 会话列表项:conversations 与 conversations/paged 的元素(toListDto 产出)。 */
export type ConversationListDto = {
  id: string;
  assistantId: string;
  title: string;
  isPinned: boolean;
  createAt: number;
  updateAt: number;
  isGenerating: boolean;
  /** 工作区归属(agent 模式):null = 对话模式。容器层按此分流会话列表。 */
  workspaceId: string | null;
};

/** 工作区(agent 模式):workspaces 路由的元素。status 为运行时计算(missing=根目录丢失)。 */
export type WorkspaceDto = {
  id: string;
  name: string;
  type: "managed" | "folder";
  root: string;
  permissionPreset: "confirm_each" | "balanced" | "full_access";
  trustedAt: number | null;
  createAt: number;
  updateAt: number;
  lastAccessAt: number;
  status: "ready" | "missing";
};

/** conversations/paged 响应包装。 */
export type PagedResult<T> = {
  items: T[];
  nextOffset?: number | null;
  hasMore: boolean;
};

/** conversations/search 响应元素(FTS 命中;snippet 用 [] 包裹匹配片段)。 */
export type MessageSearchResultDto = {
  nodeId: string;
  messageId: string;
  conversationId: string;
  title: string;
  updateAt: number;
  snippet: string;
};

// ── 文件上传 DTO ───────────────────────────────────────────────────

/** 文档全文提取状态(专题4):pending=排队/解析中,done=旁车缓存已写,empty=提取过
 *  但无文本(扫描版 PDF 等),failed=子进程崩溃/超时,none=该类型没有提取阶段(图片
 *  /音视频)。done/total 为 PDF 逐页进度,其他格式无中间进度恒为 null。 */
export type ExtractionStatusDto = {
  status: "pending" | "done" | "empty" | "failed" | "none";
  done: number | null;
  total: number | null;
};

/** files/upload 响应元素。专题4:上传落盘即返回,提取转后台——原 extractedTextLength
 *  字段随之退役,前端改轮询 files/:id/extraction 获取进度与结果。 */
export type UploadedFileDto = {
  id: number;
  url: string;
  fileName: string;
  mime: string;
  size: number;
  /** 初始提取状态:可提取文档为 "pending",其余 "none"。 */
  extraction: ExtractionStatusDto["status"];
};

export type UploadFilesResponseDto = {
  files: UploadedFileDto[];
};

// ── 应用错误通道(P2-1) ─────────────────────────────────────────────

/** 严重度:error=用户必须知道(toast),warn=可感知降级,info=仅进错误中心。 */
export type AppErrorSeverity = "info" | "warn" | "error";

/** 错误所属域(决定用户视角的归因文案与错误中心分组)。 */
export type AppErrorDomain =
  | "provider"
  | "persistence"
  | "backup"
  | "network"
  | "tool"
  | "workspace"
  | "pi-engine"
  | "media"
  | "update"
  | "internal";

/** 应用级错误条目:errors/recent 快照元素与 errors/stream SSE 载荷。 */
export type AppErrorDto = {
  id: string;
  /** 最近一次发生时间(风暴合并时更新)。 */
  at: number;
  /** 30s 窗口内同源条目的合并计数(同 domain,且 码+参数 或 message 相同)。 */
  count: number;
  severity: AppErrorSeverity;
  domain: AppErrorDomain;
  /** 中文原文:console 镜像与文案键缺失时的兜底展示。 */
  message: string;
  /** 文案键(settings:app_errors.codes.<code>),前端据此按当前界面语言渲染。 */
  code?: string;
  /** 文案插值参数。 */
  params?: Record<string, string | number>;
  detail?: string;
};

/** errors/stream SSE:连接快照(前端只入 store 不弹 toast)。 */
export type AppErrorSnapshotEventDto = {
  type: "snapshot";
  errors: AppErrorDto[];
};

/** errors/stream SSE:增量条目(前端按 severity 路由 toast)。 */
export type AppErrorPushEventDto = {
  type: "app_error";
  error: AppErrorDto;
};

// ── MCP 连接健康(7.2)───────────────────────────────────────────────

/** MCP 故障分类(与 tools/mcp-health.ts McpFailureKind 对齐;前端按它渲染人话)。 */
export type McpFailureKindDto =
  | "network_transient"
  | "auth_expired"
  | "server_unavailable"
  | "config_error"
  | "unknown";

/** 单台 MCP 服务器的健康快照(mcp_health 事件 + /api/events 初始帧的元素)。 */
export type McpHealthEntryDto =
  | { status: "ready" }
  | { status: "reconnecting"; attempt: number; maxAttempts: number }
  | {
      status: "failed";
      kind: McpFailureKindDto;
      retryable: boolean;
      message: string;
      consecutiveFailures: number;
      checkedAt: number;
    };

/** mcp_health 事件载荷:serverId → 健康项。只含"被启用且被某助手选中"的服务器(决策①)。 */
export type McpHealthSnapshotDto = Record<string, McpHealthEntryDto>;

// ── SSE 事件载荷 ───────────────────────────────────────────────────

/** 会话列表 SSE:invalidate 事件(前端收到后重拉列表)。 */
export type ConversationListInvalidateEventDto = {
  type: "invalidate";
  assistantId: string;
  timestamp: number;
};

/** 会话详情 SSE:全量快照事件。 */
export type ConversationSnapshotEventDto = {
  type: "snapshot";
  seq: number;
  conversation: ConversationDto;
  serverTime: number;
  /** 快照协商令牌(专题2 I-1):客户端重开流时经 ?token= 原样回传,不解释内容。 */
  negotiationToken: string;
};

/** 会话详情 SSE:协商命中时的轻量首帧(专题2 I-1)——客户端缓存与服务端一致,
 *  不重发全量快照,只确认订阅建立与当前生成状态。 */
export type ConversationSnapshotMetaEventDto = {
  type: "snapshot_meta";
  seq: number;
  conversationId: string;
  updateAt: number;
  isGenerating: boolean;
  negotiationToken: string;
  serverTime: number;
};

/** 会话详情 SSE:流式期间的单节点增量事件(携带完整增长中的节点)。 */
export type ConversationNodeUpdateEventDto = {
  type: "node_update";
  seq: number;
  conversationId: string;
  nodeId: string;
  nodeIndex: number;
  node: MessageNodeDto;
  /** 该节点的内容戳(I-2):客户端同步进 nodeStamps 清单,窗口化合并的比对依据。 */
  stamp: string;
  updateAt: number;
  isGenerating: boolean;
  serverTime: number;
};

/** 会话详情 SSE:流式纯文本增量帧(专题2 H-b)。
 *  仅当被选 message 相对上一帧只有 text/reasoning 的前缀增长时发出;任何结构变化
 *  (part 增删/类型变/工具输入输出/message 增删/selectIndex)走全量 node_update 关键帧。
 *  客户端以 baseLen 自校验:本地该字段长度必须落在 [baseLen, baseLen+text.length]
 *  (快照可能已含部分增量),否则视为分叉,重订阅拿快照。 */
export type ConversationTextDeltaEventDto = {
  type: "text_delta";
  seq: number;
  conversationId: string;
  nodeId: string;
  /** 增量目标 message(节点内按 id 定位,不猜 index)。 */
  messageId: string;
  deltas: Array<{ partIndex: number; baseLen: number; text: string }>;
  updateAt: number;
  isGenerating: boolean;
  serverTime: number;
};

/** 会话详情 SSE:错误事件。 */
export type ConversationErrorEventDto = {
  type: "error";
  message: string;
};

/** 会话详情 SSE:pi 引擎瞬态状态(事件名 engine-status,P5)。压缩中/自动重试中的
 *  状态条载荷,busy:false 即清除。不落库、不进快照,SSE 重连即重置(瞬态语义)。
 *  与 inference-engine/events.ts 的 EngineStatus 同构(api/sse.ts 赋值做编译期契约校验;
 *  foundation 不反向 import 引擎层,故此处独立声明)。 */
export type EngineStatusEventDto =
  | { busy: false }
  | {
      busy: true;
      /** awaiting_approval(域4-1):审批挂起期间持续——外显等待,供侧栏/标签双态点
       *  与桌面通知消费。与 events.ts EngineStatus 同构。 */
      phase: "compacting" | "retrying" | "awaiting_approval";
      /** compacting:manual/threshold/overflow;retrying 无。 */
      reason?: string;
      /** retrying:第几次/共几次。 */
      attempt?: number;
      maxAttempts?: number;
      /** compacting(UI 历史压缩):分块进度。状态条渲染"(current/total)"。 */
      progress?: { current: number; total: number };
      /** 压缩/审批开始时刻(epoch ms,服务端权威)。状态条据此渲染"已处理/已等待 xx秒",SSE 重连
       *  快照带回真实起点,切页回来计时连续。缺省时前端以首见 busy 帧时刻兜底。 */
      startedAt?: number;
      /** awaiting_approval:挂起等待的工具调用 id / 工具名 / 审批对象摘要(通知用)。 */
      toolCallId?: string;
      toolName?: string;
      summary?: string;
    };
