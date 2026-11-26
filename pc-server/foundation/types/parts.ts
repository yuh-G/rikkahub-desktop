// foundation/types/parts.ts — MessagePart 判别联合（5.4 类型硬化）
//
// 蓝本：web-ui/app/types/parts.ts（前后端契约必须一致），上游对齐安卓
// ai/src/main/java/me/rerere/ai/ui/Message.kt 的 UIMessagePart。
// 这是全应用最核心的数据结构：state.json 持久化、SSE 推送、备份 zip、
// 安卓互通全部承载它——字段增删属于冻结契约变更，必须前后端（+安卓视角）同步。
//
// 实现说明：
// - 刻意用 type alias 而非 interface：TS 只给对象字面量类型隐式索引签名，
//   这让 MessagePart 可直接赋给 JsonValue（parts 落盘/广播/备份都走 JSON，
//   "必须 JSON 可序列化"由类型系统兜底）。
// - 扩展信息（如图片 OCR 结果 metadata.ocrText/ocrStatus）一律挂 metadata，
//   不新增顶层字段；metadata 值也约束为 JsonValue。

import type { JsonValue } from "./index";

export type ToolApprovalState =
  | { type: "auto" }
  // reason:审批缘由(危险命令说明/区外写入目标),前端审批卡展示;可选字段,缺省即
  // "档位要求逐项确认"。安卓端多态解码按 type 判别,新增可选字段不破契约。
  | { type: "pending"; reason?: string }
  | { type: "approved" }
  | { type: "denied"; reason: string }
  | { type: "answered"; answer: string };

type BaseMessagePart = {
  metadata?: Record<string, JsonValue> | null;
};

export type TextPart = BaseMessagePart & {
  type: "text";
  text: string;
};

export type ImagePart = BaseMessagePart & {
  type: "image";
  url: string;
};

export type VideoPart = BaseMessagePart & {
  type: "video";
  url: string;
};

export type AudioPart = BaseMessagePart & {
  type: "audio";
  url: string;
};

export type DocumentPart = BaseMessagePart & {
  type: "document";
  url: string;
  fileName: string;
  mime: string;
};

export type ReasoningPart = BaseMessagePart & {
  type: "reasoning";
  reasoning: string;
  createdAt?: string;
  finishedAt?: string | null;
};

/** 工具执行失败时写入 output 的错误载荷。历史契约形状（{error} 裸对象，无 type
 *  判别字段），前端与消息回放层都按此容错解析，不能改成标准 part。 */
export type ToolErrorOutput = { type?: undefined; error: string };

/** ask_user 等审批/提问挂起时写入 output 的哨兵（tools/local.ts runAskUserTool）。
 *  协调器检测到它即暂停生成，等用户回答后由 resume 路径替换成真实结果。 */
export type ToolPendingOutput = {
  type?: undefined;
  pending: true;
  questions?: JsonValue[];
  note?: string;
};

/** ToolPart.output 的合法成员：标准 part + 两种历史契约载荷。 */
export type ToolOutputEntry = MessagePart | ToolErrorOutput | ToolPendingOutput;

/** 工具卡的署名(挂 metadata.attribution,P6.1):插件登记的工具记插件 id(「来自插件 X」);插件的工具调用钩子
 *  否决了这次调用时记否决方与理由(D14「被插件 X 拒绝」)。应用工具、MCP、引擎自带的工具不带。 */
export type ToolCardAttribution = {
  pluginId?: string;
  blockedBy?: { pluginId: string; reason: string };
};

export type ToolPart = BaseMessagePart & {
  type: "tool";
  toolCallId: string;
  toolName: string;
  input: string;
  output: ToolOutputEntry[];
  approvalState: ToolApprovalState;
};

/** 运行时通知(APP 端工作区的后台命令退出时产生;桌面端不产生,只承载从 APP 备份导进来的)。title 只给界面,
 *  text 是发给模型的原文:请求组装的最后一步在原位拆成一条用户消息(inference-engine/notices.ts)。
 *  界面不当气泡、不可编辑,不进全文索引、复制与 Markdown 导出。 */
export type NoticePart = BaseMessagePart & {
  type: "notice";
  title: string;
  text: string;
};

/** 生成首 token 前的占位符，收到真实增量后即被剥离；不落盘到历史。 */
export type LoadingPart = BaseMessagePart & {
  type: "loading";
  label?: string;
};

export type MessagePart =
  | TextPart
  | ImagePart
  | VideoPart
  | AudioPart
  | DocumentPart
  | ReasoningPart
  | ToolPart
  | NoticePart
  | LoadingPart;

/** 专题3 批4:PC 消息 part 判别符注册表(联合类型的运行时镜像)。MessagePart 新增成员
 *  而不登记于此 = 编译失败(下方双向断言);登记后 android-contract-sync.test.ts 会强制
 *  声明其安卓兼容性(安卓 UIMessagePart 已知类型 or 导出过滤黑名单 PC_ONLY_MESSAGE_PART_TYPES)。 */
export const PC_MESSAGE_PART_TYPES = ["text", "image", "video", "audio", "document", "reasoning", "tool", "notice", "loading"] as const;
type AssertTrue<T extends true> = T;
type MutuallyEqual<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export type _PartRegistryComplete = AssertTrue<
  MutuallyEqual<(typeof PC_MESSAGE_PART_TYPES)[number], MessagePart["type"]>
>;
