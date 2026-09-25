// model-providers/auth/catalog.ts — 订阅供应商的捆绑模型目录(方案 §2.4)。
// 数据源 = pi/packages/ai/src/providers/data/<piProviderId>.json(pi 内置 catalog 的
// 持久化快照)。登录成功后宿主直接把这些模型铺进 provider.models,用户免「获取模型列表」。
// 每条目 → 宿主 Model 的映射只做必需字段,cost/compat 等 pi 专属字段不穿透。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "../../foundation/types";
import { reportError } from "../../observability/app-errors";
import { OAUTH_FLOWS } from "./flows";
import type { OAuthFlowId } from "../../foundation/types";

type PiCatalogModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
};

// flow → 宿主 Model[](已按我们的 Model 形状归一)。模块加载时一次性解析,不缓存写路径。
const catalogCache = new Map<OAuthFlowId, Model[]>();

function dataFilePath(flowId: OAuthFlowId): string {
  const piProviderId = OAUTH_FLOWS[flowId].piProviderId;
  return join(__dirname, "..", "..", "..", "pi", "packages", "ai", "src", "providers", "data", `${piProviderId}.json`);
}

function loadCatalog(flowId: OAuthFlowId): Model[] {
  const cached = catalogCache.get(flowId);
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(dataFilePath(flowId), "utf-8")) as Record<string, Record<string, PiCatalogModel>>;
    // JSON 形状:{ "<api>": { "<modelId>": PiCatalogModel } }。拍平成数组,按 id 去重。
    const seen = new Set<string>();
    const models: Model[] = [];
    for (const group of Object.values(raw)) {
      for (const entry of Object.values(group)) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const hasImage = entry.input?.includes("image") === true;
        models.push({
          id: entry.id,
          modelId: entry.id,
          displayName: entry.name ?? entry.id,
          type: "CHAT",
          inputModalities: hasImage ? ["text", "image"] : ["text"],
          outputModalities: ["text"],
          abilities: hasImage ? ["vision"] : [],
          tools: [],
        });
      }
    }
    catalogCache.set(flowId, models);
    return models;
  } catch (error) {
    reportError("provider", "warn", `OAuth catalog load failed for ${flowId}`, error, "oauth_catalog_load_failed", { flowId });
    return [];
  }
}

/** 登录成功后调用:把该 flow 的捆绑模型铺进 provider.models(仅在 provider 当前无模型时,
 *  避免覆盖用户后来手动添加/裁剪的列表)。 */
export function bundledModelsFor(flowId: OAuthFlowId): Model[] {
  return loadCatalog(flowId).map((m) => ({ ...m }));
}
