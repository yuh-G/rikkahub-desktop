// 模型显示名的单一裁决点(getModelDisplayName):
// displayName(官方名/上游名/用户手改名)已认领即用;未认领(空,或恰与 modelId
// 相等——上游把 id 抄进 name 字段的常见形态)走启发式规整;两者皆空才退裸 id。
// 「未认领」口径与落库层(display-names.ts 的官方名写入门)共用同一把尺——
// 否则会出现「落库层认为已认领、渲染层却拿启发式覆盖」的错位。改任何模型名显示
// 都必须经它,不得自带 `model.displayName || model.modelId` 口径——兜底会漏。
import { isUnclaimedModelDisplayName, prettifyModelId } from "@server/model-providers/model-name-heuristic";

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
  if (!isUnclaimedModelDisplayName(displayName, modelId)) {
    return displayName!.trim();
  }

  const id = modelId?.trim() ?? "";
  if (id.length > 0) return prettifyModelId(id);

  return "未命名模型";
}
