// FE-P1-2:线上契约单源——本文件只做 type-only re-export,权威声明在
// pc-server/foundation/types/parts.ts(前后端契约必须一致,字段增删属冻结契约变更)。
// UIMessagePart 是前端历史别名(上游对齐安卓 UIMessagePart 命名),底层即后端 MessagePart。
export type {
  ToolApprovalState,
  TextPart,
  ImagePart,
  VideoPart,
  AudioPart,
  DocumentPart,
  ReasoningPart,
  ToolPart,
  ToolCardAttribution,
  LoadingPart,
  ToolErrorOutput,
  ToolPendingOutput,
  ToolOutputEntry,
  MessagePart,
} from "@server/foundation/types/parts";
import type { MessagePart as ServerMessagePart } from "@server/foundation/types/parts";

export type UIMessagePart = ServerMessagePart;
