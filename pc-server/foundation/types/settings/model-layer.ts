import type { Provider, Assistant, JsonValue } from "..";

export interface ModelLayerConfig {
  providers: Provider[];
  assistants: Assistant[];
  assistantTags: JsonValue[];
  /** 预置项删除墓碑(R1-12 搜索服务同款):装载时豁免缺省补齐,防删掉的预置供应商/
   *  助手重启复活。由删除端点写入,保存/重加撤销;只拦补齐,不删显式在场条目。 */
  dismissedProviderIds: string[];
  dismissedAssistantIds: string[];
}
