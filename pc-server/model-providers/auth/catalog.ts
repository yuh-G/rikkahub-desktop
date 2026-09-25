// model-providers/auth/catalog.ts — 订阅供应商的捆绑模型目录(方案 §2.4)。
// 数据源 = pi 内建 provider 目录(pi-ai providers/all 的静态导出,与 pi 引擎运行时
// getModel 取到的是同一份对象)——**必须走静态 import,不能按路径读 pi 源码的 JSON**:
// bun build --compile 出来的 exe 只带 import 图里的模块,`readFileSync(join(__dirname, "..", "pi", …))`
// 在 exe 里读不到文件,登录后模型列表为空(源码 `bun run server.ts` 跑不出这个差异)。
// 每条目 → 宿主 Model 只取必需字段(id/名称/推理/图像输入),cost/compat 等 pi 专属字段不穿透;
// 形状经 model()+enrichModel 与「获取模型列表」产出的模型完全同构(UUID id、大写模态、
// TOOL/REASONING 能力位),下游选择器/引擎不需要知道它来自目录。

import type { Api, Model as PiModel } from "../../../pi/packages/ai/src/types.ts";
import { type BuiltinProvider, getBuiltinModels } from "../../../pi/packages/ai/src/providers/all.ts";
import type { Model, OAuthFlowId } from "../../foundation/types";
import { enrichModel, model } from "../index";
import { OAUTH_FLOWS } from "./flows";

function toHostModel(entry: PiModel<Api>, existingId?: string): Model {
  const base = model(entry.id, entry.name || entry.id);
  return enrichModel({
    ...base,
    // 保留同 modelId 的既有 UUID:目录刷新不换 id,会话/助手对 model.id 的引用不失效。
    id: existingId ?? base.id,
    // pi 目录的 reasoning/input 是上游按端点维护的一手声明,优先于宿主按名字的推断
    // (kimi-for-coding 这类名字里看不出推理能力的模型,推断会漏)。
    abilities: entry.reasoning ? ["REASONING"] : [],
    inputModalities: entry.input?.includes("image") ? ["TEXT", "IMAGE"] : ["TEXT"],
  });
}

/** 该 flow 的捆绑目录(宿主 Model 形状)。existing 用于保留同 modelId 的既有 id。
 *  credential 带非空 availableModelIds 时按白名单过滤(Copilot:企业账号可能只开了部分
 *  模型,登录时 pi 写进凭证)。
 *  pi 快照里没有该 provider(vendor 基线异常)时返回空数组——调用方按「无目录」处理,
 *  用户仍可手动添加模型(pi 桥对目录外 id 有模板克隆兜底)。 */
export function bundledModelsFor(
  flowId: OAuthFlowId,
  existing: readonly Model[] = [],
  credential?: Record<string, unknown> | null,
): Model[] {
  const piProviderId = OAUTH_FLOWS[flowId].piProviderId as BuiltinProvider;
  const whitelist = Array.isArray(credential?.availableModelIds)
    ? (credential.availableModelIds as unknown[]).filter((id): id is string => typeof id === "string")
    : null;
  const existingIdByModelId = new Map(existing.map((m) => [m.modelId, m.id]));
  const seen = new Set<string>();
  const models: Model[] = [];
  for (const entry of getBuiltinModels(piProviderId) as PiModel<Api>[]) {
    if (seen.has(entry.id)) continue;
    if (whitelist && !whitelist.includes(entry.id)) continue;
    seen.add(entry.id);
    models.push(toHostModel(entry, existingIdByModelId.get(entry.id)));
  }
  return models;
}
