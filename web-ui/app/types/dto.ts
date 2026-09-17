// FE-P1-2:线上契约 DTO 单源——本文件只做 type-only re-export,权威声明在
// pc-server/foundation/types/dto.ts(后端 DTO 生成函数已标注返回类型做编译期契约校验)。
// 字段增删属冻结契约变更,必须两端同评审。
export type {
  AppErrorDto,
  AppErrorPushEventDto,
  AppErrorSnapshotEventDto,
  ConversationDto,
  ConversationErrorEventDto,
  ConversationListDto,
  ConversationListInvalidateEventDto,
  ConversationNodesPageDto,
  ConversationNodeUpdateEventDto,
  ConversationSnapshotEventDto,
  ConversationSnapshotMetaEventDto,
  ConversationTextDeltaEventDto,
  EngineStatusEventDto,
  ExtractionStatusDto,
  MessageDto,
  MessageNodeDto,
  MessageQueueItemDto,
  MessageQueueSnapshotDto,
  MessageSearchResultDto,
  PagedResult,
  UploadedFileDto,
  UploadFilesResponseDto,
  WorkspaceDto,
} from "@server/foundation/types/dto";
