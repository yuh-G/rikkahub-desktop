import type { AppConfig } from "./app-config";
import type { MemoryConfig } from "./memory-config";
import type { ModelConfig } from "./model-config";
import type { ModelLayerConfig } from "./model-layer";
import type { PluginConfig } from "./plugin-config";
import type { PromptConfig } from "./prompt-config";
import type { NetworkConfig } from "./proxy-config";
import type { SearchConfig } from "./search-config";
import type { StorageConfig } from "./storage-config";
import type { ToolConfig } from "./tool-config";
import type { VoiceConfig } from "./voice-config";

/** 聚合 Settings 接口。state.json 的序列化格式由它保证，新增/拆分 slice 时不可删除或重命名字段。 */
export interface Settings
  extends AppConfig,
    ModelConfig,
    PromptConfig,
    SearchConfig,
    VoiceConfig,
    ModelLayerConfig,
    ToolConfig,
    StorageConfig,
    NetworkConfig,
    MemoryConfig,
    PluginConfig {}

export type * from "./app-config";
export type * from "./memory-config";
export type * from "./model-config";
export type * from "./model-layer";
export type * from "./plugin-config";
export type * from "./prompt-config";
export type * from "./proxy-config";
export type * from "./search-config";
export type * from "./storage-config";
export type * from "./tool-config";
export type * from "./voice-config";
