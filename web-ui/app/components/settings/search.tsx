// components/settings/search.tsx — 搜索服务分区（19 种服务配置/测试/排序，纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Database, Loader2, Plus, Search, Trash2, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { cn } from "~/lib/utils";
import { createId } from "~/lib/id";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { SearchServiceOption, Settings } from "~/types";
import {
  clone,
  moveItem,
  numberText,
  PasswordInput,
  SectionHeader,
  SortableRow,
  textValue,
} from "~/components/settings/shared";

// Canonical labels for search services. Used in both the settings dropdown and as the
// AIIcon lookup key so the logo follows the type, not the user-entered display name.
// Order mirrors APP SearchServiceOptions.TYPES(the "add provider" picker order).
const SEARCH_SERVICE_TYPE_LABELS: Record<string, string> = {
  bing_local: "Bing",
  rikkahub: "RikkaHub",
  zhipu: "智谱",
  doubao: "豆包",
  tavily: "Tavily",
  exa: "Exa",
  searxng: "SearXNG",
  linkup: "LinkUp",
  brave: "Brave",
  metaso: "秘塔",
  ollama: "Ollama",
  perplexity: "Perplexity",
  firecrawl: "Firecrawl",
  jina: "Jina",
  bocha: "博查",
  grok: "Grok",
  tinyfish: "Tinyfish",
  serper: "Serper",
  custom_js: "Custom JS",
};

// 类型下拉的可创建清单(顺序同 SEARCH_SERVICE_TYPE_LABELS / APP TYPES)。
// 单源供 SelectContent 渲染与 backup 的 android-contract-sync.test.ts 机械化提取共用。
const SEARCH_SERVICE_CREATABLE_TYPES = [
  "bing_local",
  "rikkahub",
  "zhipu",
  "doubao",
  "tavily",
  "exa",
  "searxng",
  "linkup",
  "brave",
  "metaso",
  "ollama",
  "perplexity",
  "firecrawl",
  "jina",
  "bocha",
  "grok",
  "tinyfish",
  "serper",
  "custom_js",
] as const;

function searchServiceLabelForType(type: string | null | undefined): string {
  const key = String(type ?? "")
    .trim()
    .toLowerCase();
  if (!key) return "Search";
  return SEARCH_SERVICE_TYPE_LABELS[key] ?? key;
}

// 分隔符与后端 splitSearchApiKeys / APP KeyRoulette 一字一致(/[\s,]+/)。前端把字符串拆成多框编辑,
// 写回时再 join 成单字符串——数据结构不变,备份/APP 兼容零感知。
const SEARCH_KEY_SPLIT = /[\s,]+/;

/** 与后端 maskSearchKey 一字一致:服务端测试结果里的 key 是脱敏文本,
 *  前端需用同样算法脱敏后才能与本地输入框的原文 key 对上(issue11 修复图标从不匹配)。 */
function maskSearchKey(key: string): string {
  const k = key.trim();
  if (k.length === 0) return "";
  if (k.length <= 4) return `${k[0]}***`;
  if (k.length <= 8) return `${k.slice(0, 2)}***${k.slice(-2)}`;
  return `${k.slice(0, 3)}***${k.slice(-3)}`;
}

/** 搜索服务多 Key 编辑器:每框一个 key,框尾「×」删除,底部「+」追加。
 *  测试结果按 key 精确匹配后内联显示绿勾/红叉(汇总区另有保留)。
 *
 *  数据流:父组件存字符串(后端 splitSearchApiKeys 契约,APP 兼容),但字符串往返
 *  (split/join)无法稳定表示"空框"——filter(Boolean) 会吃掉空串,点「+」追加的空框
 *  在 value 往返后消失(曾导致+号无反应)。故本地用 state 维护框数组,onChange 只回写
 *  非空 key 序列;外部 value 变化(切换服务/父重置)经 useEffect 比对非空序列后才同步,
 *  防覆盖编辑中的空框、也防 commit→onChange→value 往返触发循环。 */
function SearchApiKeyList({
  value,
  onChange,
  testEntries,
}: {
  value: string;
  onChange: (value: string) => void;
  testEntries: Array<{ key: string; status: "ok" | "fail"; failCode?: string; detail?: string }>;
}) {
  const { t } = useTranslation();
  const [keys, setKeys] = React.useState<string[]>(() => {
    const parts = value.split(SEARCH_KEY_SPLIT).map((k) => k.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [""];
  });

  // 外部 value 变化时同步。只在"非空 key 序列"不一致时才 setKeys——既覆盖切换服务/
  // 父重置,又避免覆盖编辑中的空框/中间状态,还阻断 commit→onChange→value 往返循环。
  React.useEffect(() => {
    const parts = value.split(SEARCH_KEY_SPLIT).map((k) => k.trim()).filter(Boolean);
    const external = parts.length > 0 ? parts : [""];
    const localNonEmpty = keys.filter((k) => k.trim()).map((k) => k.trim());
    if (localNonEmpty.join("\n") !== external.join("\n")) setKeys(external);
    // 故意不依赖 keys:commit 时本地已 setKeys,不需要 value 回来再同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 本地立即更新(保留空框);onChange 只回写非空 key(换行 join——换行属于 \s,
  // 与后端 /[\s,]+/ 兼容,key 不含换行,比逗号/空格更不易和 key 本身冲突)。
  const commit = (next: string[]) => {
    setKeys(next);
    onChange(next.filter((k) => k.trim()).join("\n"));
  };
  const update = (index: number, val: string) => {
    const next = [...keys];
    next[index] = val;
    commit(next);
  };
  const add = () => commit([...keys, ""]);
  const remove = (index: number) => {
    if (keys.length <= 1) {
      commit([""]); // 唯一框:删 = 清空,仍保留一个可编辑框
      return;
    }
    commit(keys.filter((_, i) => i !== index));
  };
  // 失焦时收掉尾部连续空框(点 + 又没填)。中间空框不动——用户可能还要填。
  const trimTrailingEmpty = () => {
    let next = [...keys];
    while (next.length > 1 && next[next.length - 1].trim() === "") next.pop();
    if (next.length !== keys.length) commit(next);
  };

  return (
    <div className="space-y-2">
      {keys.map((key, index) => {
        // 改了 key 后脱敏文本变化,旧测试结果自动对不上、图标消失——符合预期。
        const entry = key ? testEntries.find((e) => e.key === maskSearchKey(key)) : undefined;
        return (
          <div key={index} className="flex items-center gap-2">
            <div className="flex-1">
              <PasswordInput value={key} onChange={(v) => update(index, v)} onBlur={trimTrailingEmpty} />
            </div>
            {entry ? (
              entry.status === "ok" ? (
                <CheckCircle2
                  className="size-4 shrink-0 text-success"
                  aria-label={t("settings:search.key_ok")}
                />
              ) : (
                // issue11:title 放在 span 上(SVG 元素的 title 属性不触发浏览器 tooltip),
                // 悬停可见底层错误原文。
                <span className="flex shrink-0" title={entry.detail || undefined}>
                  <XCircle
                    className="size-4 shrink-0 text-destructive"
                    aria-label={t(`settings:search.key_fail_${entry.failCode ?? "other"}`)}
                  />
                </span>
              )
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => remove(index)}
              aria-label={t("settings:search.key_remove")}
              title={t("settings:search.key_remove")}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}
      {/* +号独立放底部:所有 key 框只有 input+叉号,等宽;末框不再被+号挤窄。 */}
      <Button type="button" variant="outline" size="sm" onClick={add} className="w-full justify-center">
        <Plus className="size-4" />
        {t("settings:search.key_add")}
      </Button>
    </div>
  );
}

const DEFAULT_CUSTOM_JS_SEARCH_SCRIPT = `async function search(query, resultSize) {
  const encoded = encodeURIComponent(query);
  const res = await fetch("https://example.com/search?q=" + encoded + "&limit=" + resultSize);
  const data = await res.json();
  return {
    items: data.results.map(function(r) {
      return { title: r.title, url: r.url, text: r.snippet };
    })
  };
}`;

const DEFAULT_CUSTOM_JS_SCRAPE_SCRIPT = `async function scrape(urls) {
  return {
    urls: await Promise.all(urls.map(async function(url) {
      const res = await fetch(url);
      const body = await res.text();
      return { url: url, content: body };
    }))
  };
}`;

function createSearchService(): Record<string, unknown> {
  return {
    id: createId(),
    type: "tavily",
    name: "Tavily",
    apiKey: "",
    depth: "advanced",
  };
}

function toSearchService(value: Record<string, unknown>): SearchServiceOption {
  return { ...value, id: String(value.id ?? createId()) } as SearchServiceOption;
}

export function SearchSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const [selectedId, setSelectedId] = React.useState(
    String(
      settings.searchServices[settings.searchServiceSelected]?.id ??
        settings.searchServices[0]?.id ??
        "",
    ),
  );
  const selected = (settings.searchServices.find((item) => String(item.id) === selectedId) ??
    settings.searchServices[0]) as Record<string, unknown> | undefined;
  const [draft, setDraft] = React.useState<Record<string, unknown>>(
    selected ? clone(selected) : createSearchService(),
  );
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const [keyTestEntries, setKeyTestEntries] = React.useState<
    Array<{ key: string; status: "ok" | "fail"; failCode?: string; detail?: string }>
  >([]);
  const { t } = useTranslation();

  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      const result = await api.post<{ service: Record<string, unknown> }>(
        "settings/search/service/detail",
        draft,
      );
      const savedService = toSearchService(result.service);
      const exists = settings.searchServices.some(
        (item) => String(item.id) === String(savedService.id),
      );
      const searchServices = exists
        ? settings.searchServices.map((item) =>
            String(item.id) === String(savedService.id) ? savedService : item,
          )
        : [...settings.searchServices, savedService];
      onSettings({ ...settings, searchServices });
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:search.autosave_failed")) },
  );

  // searchServicesRef: avoid re-running this effect after every autosave → onSettings
  // round-trip (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const searchServicesRef = React.useRef(settings.searchServices);
  searchServicesRef.current = settings.searchServices;
  React.useEffect(() => {
    const next = (searchServicesRef.current.find((item) => String(item.id) === selectedId) ??
      searchServicesRef.current[0]) as Record<string, unknown> | undefined;
    if (next) setDraft(clone(next));
    autosave.reset();
    setTestResult("");
  }, [selectedId]);

  const patchDraft = (patch: Record<string, unknown>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };

  const moveSearchService = async (from: number, to: number) => {
    const searchServices = moveItem(settings.searchServices, from, to);
    const selectedId = settings.searchServices[settings.searchServiceSelected]?.id;
    const searchServiceSelected = Math.max(
      0,
      searchServices.findIndex((item) => item.id === selectedId),
    );
    const next = { ...settings, searchServices, searchServiceSelected };
    onSettings(next);
    await api.post("settings/search/reorder", {
      ids: searchServices.map((item) => item.id),
      selectedId,
    });
  };
  const selectService = async (index: number) => {
    setSelectedId(String(settings.searchServices[index]?.id ?? ""));
    onSettings({ ...settings, searchServiceSelected: index });
    await api.post("settings/search/service", { index });
  };
  // 测试前的"确保服务端拿到当前草稿"。原手动 save 与自动保存是两份重复的 POST+合并逻辑,
  // 现统一为 hook 的 persist 体;原顺带改写全局 searchServiceSelected 的行为是自动保存
  // 之前的遗留(测试一个服务不应劫持全局选中),一并去除。
  const save = () => autosave.saveNow({ force: true });
  const addService = () => {
    const service = createSearchService();
    void api
      .post<{ service: Record<string, unknown> }>("settings/search/service/detail", service)
      .then((result) => {
        const savedService = toSearchService(result.service);
        const searchServices = [...settings.searchServices, savedService];
        onSettings({
          ...settings,
          searchServices,
          searchServiceSelected: searchServices.length - 1,
        });
        setDraft(savedService as unknown as Record<string, unknown>);
        setSelectedId(String(savedService.id));
        setTestResult("");
        toast.success(t("settings:search.added"));
      })
      .catch((error: Error) => toast.error(error.message || t("settings:search.add_failed")));
  };
  const test = async () => {
    setTesting(true);
    setTestResult(t("settings:search.testing_start"));
    setKeyTestEntries([]);
    try {
      await save();
      const result = await api.post<{
        status: "ok" | "fail";
        endpoint: string;
        preview: string;
        keys?: Array<{ key: string; status: "ok" | "fail"; failCode?: string; detail?: string }>;
      }>("settings/search/service/test", draft);
      const keys = Array.isArray(result.keys) ? result.keys : [];
      const okCount = keys.filter((k) => k.status === "ok").length;
      if (result.status === "ok") {
        if (keys.length > 1 && okCount < keys.length) {
          setTestResult(
            t("settings:search.test_partial", {
              endpoint: result.endpoint,
              ok: okCount,
              total: keys.length,
              failed: keys.length - okCount,
              preview: result.preview,
            }),
          );
        } else if (keys.length > 1) {
          setTestResult(
            t("settings:search.test_all_ok", {
              endpoint: result.endpoint,
              count: keys.length,
              preview: result.preview,
            }),
          );
        } else {
          setTestResult(
            t("settings:search.test_success", { endpoint: result.endpoint, preview: result.preview }),
          );
        }
        toast.success(t("settings:search.test_ok"));
        // Refresh settings so the "已通过测试" badge updates (server marks testPassed on success).
        onSettings(await api.get<Settings>("settings"));
      } else {
        // 多 key 全部失败:展示汇总 + 每个 key 的失败明细;单 key 失败:直接给出友好原因
        // (如"密钥无效或已过期"),比原来的 "401: {body}" 更易懂。
        // issue11:友好原因之外附上服务端记录的底层错误原文(超时/证书/DNS/5xx 等),
        // 否则统一显示"网络异常或服务暂不可用",用户无从排查。
        const singleFailReason =
          keys.length === 1
            ? t(`settings:search.key_fail_${keys[0]?.failCode ?? "other"}`)
            : null;
        const singleFailDetail = keys.length === 1 ? keys[0]?.detail : undefined;
        setTestResult(
          keys.length > 1
            ? t("settings:search.test_all_failed", { count: keys.length })
            : [singleFailReason ?? t("settings:search.test_failed"), singleFailDetail].filter(Boolean).join("\n\n"),
        );
        toast.error(singleFailReason ?? t("settings:search.test_failed"));
      }
      setKeyTestEntries(keys);
    } catch (error) {
      // 无 key 服务(searxng/custom_js)失败、网络异常等仍以非 2xx 抛出,走这里。
      const message = error instanceof Error ? error.message : t("settings:search.test_failed");
      setTestResult(message);
      setKeyTestEntries([]);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirmDialog({
        title: t("settings:search.delete_confirm", {
          name: textValue(draft.name) || textValue(draft.type),
        }),
        danger: true,
      }))
    )
      return;
    // 防复活:丢弃待保存脏编辑并等在飞保存收尾,DELETE 不与迟到 POST 乱序(复审 F1)
    await autosave.discard();
    await api.delete(`settings/search/service/${encodeURIComponent(String(draft.id))}`);
    const searchServices = settings.searchServices.filter(
      (item) => String(item.id) !== String(draft.id),
    );
    onSettings({ ...settings, searchServices, searchServiceSelected: 0 });
    setSelectedId(String(searchServices[0]?.id ?? ""));
    // 删到空:重对齐 effect 无条目可载,草稿若停留在已删实体上,再编辑一笔就会经
    // 自动保存复活它。复位为挂载空列表时同款的空白新草稿(复审 F2)。
    if (!searchServices.length) setDraft(createSearchService());
    toast.success(t("settings:search.deleted"));
  };

  return (
    <>
      <SectionHeader
        icon={Search}
        title={t("settings:search.title")}
        subtitle={t("settings:search.subtitle")}
      />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-2 rounded-lg border bg-card p-2">
          <Button className="w-full justify-start" variant="outline" onClick={addService}>
            <Plus className="size-4" />
            {t("settings:search.add")}
          </Button>
          {settings.searchServices.map((service, index) => (
            <SortableRow
              key={String(service.id ?? index)}
              id={String(service.id ?? index)}
              index={index}
              active={String(service.id) === String(draft.id)}
              onSelect={() => selectService(index)}
              onMove={moveSearchService}
            >
              <span className="grid min-w-0 grid-cols-[34px_minmax(0,1fr)_36px] items-center gap-3 text-left">
                <AIIcon
                  name={searchServiceLabelForType(textValue(service.type))}
                  size={30}
                  className="justify-self-start"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate font-medium">
                    {(() => {
                      const type = String(service.type ?? "").toLowerCase();
                      const isPreset = type === "bing_local" || type === "rikkahub";
                      const passed =
                        isPreset || (service as Record<string, unknown>).testPassed === true;
                      return (
                        <span
                          aria-hidden
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            passed ? "bg-success" : "bg-muted-foreground/40",
                          )}
                          title={
                            passed
                              ? isPreset
                                ? t("settings:search.preset_ok")
                                : t("settings:search.passed")
                              : t("settings:search.not_passed")
                          }
                        />
                      );
                    })()}
                    <span className="truncate">
                      {textValue(service.name) ||
                        searchServiceLabelForType(textValue(service.type))}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {textValue(service.type) || JSON.stringify(service)}
                  </span>
                </span>
                {index === settings.searchServiceSelected ? (
                  <span className="shrink-0 text-xs text-primary">
                    {t("settings:search.current")}
                  </span>
                ) : null}
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <div className="flex items-center gap-3">
            <AIIcon name={searchServiceLabelForType(textValue(draft.type))} size={40} />
            <div>
              <div className="text-lg font-medium">
                {textValue(draft.name) ||
                  searchServiceLabelForType(textValue(draft.type)) ||
                  t("settings:search.service_default")}
              </div>
              <div className="text-xs text-muted-foreground">
                {textValue(draft.type) || "custom"}
              </div>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.name")}</span>
              <Input
                value={textValue(draft.name)}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.type")}</span>
              <Select
                value={textValue(draft.type) || "tavily"}
                onValueChange={(type) => {
                  // Re-sync `name` whenever it was still the previous type's default label —
                  // that way the row icon and detail-pane logo follow the chosen type. Manual
                  // names (anything not matching the canonical label) are preserved.
                  const previousType = textValue(draft.type);
                  const previousLabel = searchServiceLabelForType(previousType);
                  const currentName = textValue(draft.name);
                  const isDefaultName =
                    !currentName || currentName === previousLabel || currentName === previousType;
                  patchDraft({
                    type,
                    name: isDefaultName ? searchServiceLabelForType(type) : currentName,
                    ...(type === "custom_js" && !textValue(draft.searchScript)
                      ? {
                          searchScript: DEFAULT_CUSTOM_JS_SEARCH_SCRIPT,
                          scrapeScript: DEFAULT_CUSTOM_JS_SCRAPE_SCRIPT,
                        }
                      : {}),
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEARCH_SERVICE_CREATABLE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      <span className="flex items-center gap-2">
                        <AIIcon
                          name={searchServiceLabelForType(type)}
                          size={16}
                          className="bg-transparent"
                        />
                        {searchServiceLabelForType(type)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {textValue(draft.type) !== "searxng" && textValue(draft.type) !== "custom_js" ? (
              <div className="space-y-2 md:col-span-2">
                <span className="text-sm font-medium">API Key</span>
                <SearchApiKeyList
                  value={textValue(draft.apiKey)}
                  onChange={(apiKey) => patchDraft({ apiKey })}
                  testEntries={keyTestEntries}
                />
                <span className="text-xs text-muted-foreground">{t("settings:search.api_key_hint")}</span>
              </div>
            ) : null}
            {textValue(draft.type) === "doubao" ? (
              // 豆包(火山 Search-Infinity)两模:global=综合搜索(带图),custom=网页搜索。
              // 对齐 APP DoubaoOptions 的 Mode 分段选择器。
              <label className="space-y-2">
                <span className="text-sm font-medium">Mode</span>
                <Select
                  value={textValue(draft.mode) || "custom"}
                  onValueChange={(mode) => patchDraft({ mode })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {textValue(draft.type) === "searxng" ? (
              <>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">SearXNG URL</span>
                  <Input
                    value={textValue(draft.url)}
                    onChange={(event) => patchDraft({ url: event.target.value })}
                    placeholder="https://search.example.com"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Engines</span>
                  <Input
                    value={textValue(draft.engines)}
                    onChange={(event) => patchDraft({ engines: event.target.value })}
                    placeholder="google,bing"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Language</span>
                  <Input
                    value={textValue(draft.language)}
                    onChange={(event) => patchDraft({ language: event.target.value })}
                    placeholder="zh-CN"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Username</span>
                  <Input
                    value={textValue(draft.username)}
                    onChange={(event) => patchDraft({ username: event.target.value })}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Password</span>
                  <PasswordInput
                    value={textValue(draft.password)}
                    onChange={(password) => patchDraft({ password })}
                  />
                </label>
              </>
            ) : null}
            {textValue(draft.type) === "custom_js" ? (
              <>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">Search Script</span>
                  <Textarea
                    value={textValue(draft.searchScript)}
                    onChange={(event) => patchDraft({ searchScript: event.target.value })}
                    className="min-h-56 font-mono text-xs"
                    placeholder={
                      "async function search(query, resultSize) {\n  const res = await fetch('https://example.com/search?q=' + encodeURIComponent(query));\n  const data = await res.json();\n  return { items: data.results.map((r) => ({ title: r.title, url: r.url, text: r.snippet })) };\n}"
                    }
                  />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium">Scrape Script</span>
                  <Textarea
                    value={textValue(draft.scrapeScript)}
                    onChange={(event) => patchDraft({ scrapeScript: event.target.value })}
                    className="min-h-40 font-mono text-xs"
                    placeholder={
                      "async function scrape(urls) {\n  return { urls: await Promise.all(urls.map(async (url) => {\n    const res = await fetch(url);\n    return { url, content: await res.text() };\n  })) };\n}"
                    }
                  />
                </label>
              </>
            ) : null}
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.depth")}</span>
              <Select
                value={textValue(draft.depth) || "standard"}
                onValueChange={(depth) => patchDraft({ depth })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="basic">Basic</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="advanced">Advanced</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:search.result_count")}</span>
              <Input
                value={numberText(
                  draft.resultSize ?? settings.searchCommonOptions.resultSize,
                )}
                onChange={(event) => patchDraft({ resultSize: Number(event.target.value) || 10 })}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={test} disabled={testing}>
              {testing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Database className="size-4" />
              )}
              {t("settings:search.test")}
            </Button>
            <Button
              variant="outline"
              onClick={remove}
              disabled={
                !settings.searchServices.some((item) => String(item.id) === String(draft.id))
              }
            >
              <Trash2 className="size-4" />
              {t("settings:search.delete")}
            </Button>
            <AutosaveStatusRow
              status={autosave.status}
              onRetry={() => void autosave.saveNow()}
            />
          </div>
          {testResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {testResult}
            </pre>
          ) : null}
          {keyTestEntries.length > 1 ? (
            <div className="space-y-1.5 rounded-md border bg-card p-3">
              <div className="text-xs font-medium text-muted-foreground">
                {t("settings:search.key_status_title")}
              </div>
              {keyTestEntries.map((entry, index) => (
                <div key={index} className="space-y-0.5">
                  <div className="flex items-center gap-2 text-xs">
                    {entry.status === "ok" ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                    ) : (
                      <XCircle className="size-3.5 shrink-0 text-destructive" />
                    )}
                    <code className="font-mono">{entry.key}</code>
                    <span
                      className={cn(
                        "text-muted-foreground",
                        entry.status === "fail" && "text-destructive",
                      )}
                    >
                      {entry.status === "ok"
                        ? t("settings:search.key_ok")
                        : t(`settings:search.key_fail_${entry.failCode ?? "other"}`)}
                    </span>
                  </div>
                  {/* issue11:失败时附底层错误原文,便于区分超时/证书/DNS/5xx */}
                  {entry.status === "fail" && entry.detail ? (
                    <div className="pl-5.5 font-mono text-mini break-all text-muted-foreground">
                      {entry.detail}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
