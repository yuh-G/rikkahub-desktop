// 插件管理接口的线上契约:只做 type-only re-export,权威声明在 pc-server/foundation/types/plugins.ts
// (插件记录本身在 settings/plugin-config.ts)。字段增删两端同评审。
export type {
  EnginePluginAuditDto,
  EnginePluginDetailDto,
  EnginePluginInspectionDto,
  EnginePluginListDto,
  EnginePluginMutationDto,
  EnginePluginUpdatesDto,
  EnginePluginUploadConflictDto,
  EnginePluginViewDto,
  PluginAuditEntryDto,
  PluginEngineDto,
  PluginInstallProgressDto,
  PluginInstallProgressEventDto,
  PluginMarketDetailDto,
  PluginMarketItemDto,
  PluginMarketPageDto,
  PluginMarketSourceDto,
  PluginMarketSourcesDto,
  PluginReinstallStateEventDto,
} from "@server/foundation/types/plugins";
export type {
  EnginePluginMeta,
  EnginePluginRecord,
  EnginePluginSource,
  PluginMarketSourceRecord,
} from "@server/foundation/types/settings";
export type { CommandSource } from "@server/foundation/types/commands";
