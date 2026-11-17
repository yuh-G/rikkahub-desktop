// 插件管理接口(pc-server/api/handlers/plugins.ts)的调用;返回形状见 types/plugins.ts。安装 / 重装 / 更新 / 上传可能要
// 几分钟(后端上限 5 分钟),这几个关掉客户端的 30 秒超时。
import api, { ApiError, appendWebAuthQuery, notifyWebAuthRequired } from "~/services/api";
import { setMarketSources, setPluginList, setPluginUpdates } from "~/stores/plugins-view-store";
import type {
  EnginePluginAuditDto,
  EnginePluginDetailDto,
  EnginePluginListDto,
  EnginePluginMutationDto,
  EnginePluginSource,
  EnginePluginUpdatesDto,
  EnginePluginUploadConflictDto,
  EnginePluginViewDto,
  PluginMarketDetailDto,
  PluginMarketPageDto,
  PluginMarketSourceDto,
  PluginMarketSourcesDto,
} from "~/types/plugins";

const LONG = { timeout: false } as const;

export type PluginUploadResult =
  | { kind: "installed"; plugin: EnginePluginViewDto }
  | { kind: "conflict"; existing: EnginePluginViewDto };

export const pluginsApi = {
  list: () => api.get<EnginePluginListDto>("plugins"),
  detail: (id: string) => api.get<EnginePluginDetailDto>("plugins/detail", { searchParams: { id } }),
  audit: (id: string) => api.get<EnginePluginAuditDto>("plugins/audit", { searchParams: { id } }),
  updates: (refresh = false) =>
    api.get<EnginePluginUpdatesDto>("plugins/updates", { searchParams: refresh ? { refresh: "1" } : {} }),
  install: (source: EnginePluginSource, engine = "pi") =>
    api.post<EnginePluginMutationDto>("plugins/install", { engine, source }, LONG),
  reinstall: (id: string) => api.post<EnginePluginMutationDto>("plugins/reinstall", { id }, LONG),
  update: (id: string) => api.post<EnginePluginMutationDto>("plugins/update", { id }, LONG),
  uninstall: (id: string) => api.post<{ status: "ok" }>("plugins/uninstall", { id }, LONG),
  setEnabled: (id: string, enabled: boolean) => api.post<EnginePluginMutationDto>("plugins/enabled", { id, enabled }),
  setSwitches: (
    id: string,
    patch: { toolCall?: boolean; tools?: Record<string, { enabled?: boolean; exempt?: boolean }> },
  ) => api.post<EnginePluginMutationDto>("plugins/switches", { id, ...patch }),

  marketSources: () => api.get<PluginMarketSourcesDto>("plugins/market/sources"),
  addMarketSource: (input: { url: string; name?: string; engine?: string }) =>
    api.post<{ source: PluginMarketSourceDto }>("plugins/market/sources", input, LONG),
  removeMarketSource: (id: string) => api.post<{ status: "ok" }>("plugins/market/sources/remove", { id }),
  market: (source: string, query: string, page: number, refresh = false) =>
    api.get<PluginMarketPageDto>("plugins/market", {
      searchParams: { source, q: query, page: String(page), ...(refresh ? { refresh: "1" } : {}) },
      ...LONG,
    }),
  marketDetail: (source: string, name: string) =>
    api.get<PluginMarketDetailDto>("plugins/market/detail", { searchParams: { source, name }, ...LONG }),

  /** 409 同名不是错误:交回已装的那条,界面问过后带 replace 重发。其它失败抛 ApiError(带后端的错误码)。
   *  走原生 fetch:ky 的错误收口只留 message / code,丢掉 409 里的 existing。 */
  async upload(file: File, options: { engine?: string; replace?: boolean } = {}): Promise<PluginUploadResult> {
    const form = new FormData();
    form.append("file", file);
    form.append("engine", options.engine ?? "pi");
    if (options.replace) form.append("replace", "1");
    let res: Response;
    try {
      res = await fetch(appendWebAuthQuery("/api/plugins/upload"), { method: "POST", body: form });
    } catch {
      throw new ApiError("network_unreachable", 0, "network_unreachable");
    }
    const data = (await res.json().catch(() => ({}))) as Partial<EnginePluginMutationDto & EnginePluginUploadConflictDto>;
    if (res.status === 409 && data.existing) return { kind: "conflict", existing: data.existing };
    if (res.ok && data.plugin) return { kind: "installed", plugin: data.plugin };
    if (res.status === 401) notifyWebAuthRequired({ message: data.error ?? res.statusText, code: 401 });
    throw new ApiError(data.error ?? res.statusText, data.code ?? res.status, data.errorCode);
  },
};

/** 首页与详情共用的两份补充数据(包在不在、加载失败、运行记录条数;有没有更新),取回后放进视图仓库。 */
export async function refreshPluginList(): Promise<void> {
  // 取不到只是少了徽标:行由设置里的记录画出,不打扰用户。
  const list = await pluginsApi.list().catch(() => null);
  if (list) setPluginList(list);
}

/** 返回取到的更新表;取不到为 null。 */
export async function refreshPluginUpdates(refresh = false): Promise<EnginePluginUpdatesDto["updates"] | null> {
  // 同上;后端查不到 registry 时本来就按「没查到」返回。
  const result = await pluginsApi.updates(refresh).catch(() => null);
  if (result) setPluginUpdates(result.updates);
  return result?.updates ?? null;
}

/** 市场源表(内置 + 用户添加)。失败时抛出,由市场视图显示重试。 */
export async function refreshMarketSources(): Promise<void> {
  setMarketSources((await pluginsApi.marketSources()).sources);
}
