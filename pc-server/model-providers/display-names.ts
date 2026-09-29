// model-providers/display-names.ts — models.dev 官方显示名的解析与落库(权威层)
//
// 分层契约的另一端(启发式在 model-name-heuristic.ts):启发式给「第一帧的规整名」,
// 本模块随后把 models.dev 的官方名**静默落库**。两者由「displayName === modelId」
// 这个「未认领」信号隔开——只有还顶着裸 id 的行才允许被官方名认领;
// 用户手改名 / 上游接口给的 name / OAuth 目录名 / 已填过的官方名,一律不碰。
// (启发式永不落库的完整理由见 model-name-heuristic.ts 头注。)
//
// 查表纪律继承 model-limits.ts:按**端点身份**(resolveCatalogKeys 三级阶梯)取值,
// 不按名字搜全目录——「这个模型的名字该听谁的」和「这个模型的上限该听谁的」是
// 同一个问题。但与取上限的两点刻意不同:
//   ① 只取精确 id 匹配,不取版本前缀行(limitRowTiers 的 prefixed 层)——前缀行是
//     「同家族另一个模型」的名字,取来就是张冠李戴;上下文窗口取 min 仍属合理近似,
//     显示名取错没有任何辩护余地。
//   ② 同 host 多键(zhipuai + zhipuai-coding-plan)取**首个命中**而非 min——名字不是
//     数值,没有 min 语义;两家目录对同名 id 的 name 一致(同厂数据源),冲突无实义。

import type { Model, Provider } from "../foundation/types";
import { updateSettings } from "../app-config";
import { state } from "../persistence/json-store";
import { hostOfProvider } from "../inference-engine/message-builder";
import type { ModelCatalog } from "./model-limits";
import { resolveCatalogKeys } from "./model-limits";

/** 官方名里的目录噪音后缀:同模型的无日期别名行标 "(latest)",与带日期行显示不同名
 *  只制造混乱(用户拍板 2026-09-29:claude-opus-4-5 → "Claude Opus 4.5",不带 latest)。
 *  其余括注((preview)/(free)/(EU)…)承载真实语义,保留。 */
const CATALOG_NOISE_SUFFIX = /\s*\((latest)\)\s*$/i;

/** 按端点身份查模型的官方显示名。查不到(目录无此模型 / 精确 id 不存在 / 目录未加载)
 *  返回 null——调用方保持现状,启发式兜底继续生效。 */
export function officialDisplayNameFor(catalog: ModelCatalog | null, host: string, modelId: string): string | null {
  if (!catalog || !modelId) return null;
  for (const key of resolveCatalogKeys(catalog, host)) {
    const name = catalog[key]?.models?.[modelId]?.name;
    if (typeof name === "string" && name.trim()) return name.replace(CATALOG_NOISE_SUFFIX, "").trim();
  }
  return null;
}

/** 一行是否「未被认领」:displayName 与 modelId 相等(含空串退化,见 isClaimed 判定)。
 *  这是官方名唯一允许写入的门;任何其他形态的 displayName 都代表已有主人。 */
export function isUnclaimedDisplayName(model: Model): boolean {
  const display = String(model.displayName ?? "").trim();
  if (!display) return true; // 退化数据:视同未认领,允许补名
  return display === model.modelId;
}

/** 批量回填:扫全部供应商的模型行,给「未认领」且目录有官方名的行填名。
 *  幂等——填过的行脱离未认领态,下次零写入、零 SSE 广播;目录每日刷新后新收录的
 *  模型会在下一轮回填中自然补上。目录未加载(启动窗口期/网络失败)时静默返回。
 *  整轮回填只产生一次 updateSettings(有变更时),不逐行写盘。 */
export function backfillModelDisplayNames(catalog: ModelCatalog | null): void {
  if (!catalog) return;
  let changed = false;
  const nextProviders = state.settings.providers.map((providerItem: Provider) => {
    let providerChanged = false;
    const models = (providerItem.models ?? []).map((modelItem: Model) => {
      if (!isUnclaimedDisplayName(modelItem)) return modelItem;
      const host = hostOfProvider(providerItem);
      const official = officialDisplayNameFor(catalog, host, modelItem.modelId);
      if (!official || official === modelItem.displayName) return modelItem;
      providerChanged = true;
      return { ...modelItem, displayName: official };
    });
    if (!providerChanged) return providerItem;
    changed = true;
    return { ...providerItem, models };
  });
  if (!changed) return;
  updateSettings({ ...state.settings, providers: nextProviders });
}
