// 模型显示名的单一裁决点(getModelDisplayName):
// displayName(官方名/上游名/用户手改名)非空即用;否则启发式规整(第一帧的确定性
// 体面下限);两者皆空才退裸 id。改任何模型名显示都必须经它,不得自带
// `model.displayName || model.modelId` 口径——兜底会漏。
import { prettifyModelId } from "@server/model-providers/model-name-heuristic";

export function getDisplayName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : fallback;
}

export function getAssistantDisplayName(name: string | null | undefined): string {
  return getDisplayName(name, "默认助手");
}

export function getModelDisplayName(
  displayName: string | null | undefined,
  modelId: string | null | undefined,
): string {
  const normalizedDisplayName = displayName?.trim() ?? "";
  if (normalizedDisplayName.length > 0) {
    return normalizedDisplayName;
  }

  const id = modelId?.trim() ?? "";
  if (id.length > 0) return prettifyModelId(id);

  return "未命名模型";
}
