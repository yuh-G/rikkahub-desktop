// components/settings/providers/index.tsx — 模型 › 供应商页:左列表,右配置(连接 → 模型 → 测试 → 高级[默认收起])。
// 详情各节拆在同目录:login-panel(订阅登录)、model-list(模型)、test-panel(测试)、common(纯函数)。
// 本文件持有草稿与自动保存,子节只经 patchDraft 改草稿。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, Database, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { SegmentedControl } from "~/components/ui/segmented-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { StatusBadge } from "~/components/ui/status-badge";
import { Switch } from "~/components/ui/switch";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { isBalanceResultPathValid } from "~/lib/json-expression";
import { patchSettingsLocal, upsertById } from "~/lib/settings-patch";
import { openExternal } from "~/lib/external-link";
import { DEFAULT_BASE_URLS, type ProviderKind } from "~/lib/provider-base-urls";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import { getSettingsParam } from "~/stores/settings-dialog-store";
import type { ProviderModel, ProviderProfile, Settings } from "~/types";
import {
  clone,
  moveItem,
  PasswordInput,
  SettingsAdvancedSection,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsField,
  SettingsGroup,
  SettingsRows,
  SettingsListAddButton,
  SettingsListRow,
  SettingsSplit,
  SettingsStack,
  SettingsSwitchRow,
  textValue,
} from "~/components/settings/shared";
import {
  applyAutoModelType,
  balanceOptionOf,
  createProvider,
  defaultPathForKind,
  endpointPreview,
  hasCustomEndpointPath,
  KIND_LABEL_KEYS,
  modelListEndpointPreview,
  normalizeKindPatch,
  OPENAI_FORMATS,
  PROVIDER_KINDS,
  providerFormatLabelKey,
  providerGetKeyUrl,
  providerKind,
} from "~/components/settings/providers/common";
import { ProviderLoginPanel } from "~/components/settings/providers/login-panel";
import { ProviderModelList } from "~/components/settings/providers/model-list";
import { ProviderTestPanel } from "~/components/settings/providers/test-panel";

export function ProvidersSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  // ?providerId= deep-link is only honored on first mount, so subsequent settings updates
  // (autosave, SSE) don't snap the selection back to the URL value or the default first provider.
  const initialProviderId = React.useMemo(() => {
    const providerId = getSettingsParam("providerId");
    if (providerId && settings.providers.some((provider) => provider.id === providerId))
      return providerId;
    return settings.providers[0]?.id ?? "";
    // Intentionally empty deps: capture only the initial value. We don't want to re-derive on
    // every settings update because that pulls selectedId back to the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 深链高亮的模型只属于深链指向的那个供应商;切到别的供应商不再高亮同名模型。
  const deepLink = React.useMemo(
    () => ({ providerId: getSettingsParam("providerId"), modelId: getSettingsParam("modelId") ?? "" }),
    [],
  );
  const [selectedId, setSelectedId] = React.useState(initialProviderId);
  const selected =
    settings.providers.find((provider) => provider.id === selectedId) ?? settings.providers[0];
  const [draft, setDraft] = React.useState<ProviderProfile | null>(
    selected ? clone(selected) : null,
  );
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [checkingBalance, setCheckingBalance] = React.useState(false);
  const [balanceResult, setBalanceResult] = React.useState("");
  const [fetchedModels, setFetchedModels] = React.useState<ProviderModel[]>([]);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      if (!draft) return;
      await api.post("settings/provider", draft);
      patchSettingsLocal((current) => ({
        providers: current.providers.map((provider) => (provider.id === draft.id ? draft : provider)),
      }));
    },
    { onSaveError: (error) => toast.error((error as Error).message || t("settings:providers.autosave_failed")) },
  );
  const lastSelectedRef = React.useRef(selectedId);

  // 「高级设置」展开态:切换供应商不收起,离开本页(重挂载)复位为收起。
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  // providersRef lets this realignment effect read the freshest providers list without
  // depending on settings.providers — otherwise every autosave → onSettings round-trip
  // re-fires the effect and overwrites mid-flight keystrokes. Same class of bug as
  // McpServerEditor; see there for the full rationale.
  const providersRef = React.useRef(settings.providers);
  providersRef.current = settings.providers;
  React.useEffect(() => {
    const next =
      providersRef.current.find((provider) => provider.id === selectedId) ?? providersRef.current[0];
    const selectedChanged = lastSelectedRef.current !== selectedId;
    lastSelectedRef.current = selectedId;
    setDraft(next ? clone(next) : null);
    autosave.reset();
    if (selectedChanged) {
      setFetchedModels([]);
      setBalanceResult("");
    }
  }, [selectedId]);

  // 登录/登出是服务端写路径(commitLogin 置 enabled=true 并铺入捆绑模型,logoutProvider 置
  // enabled=false 剥 oauth),而 draft 刻意不随 SSE 刷新(防键击被覆盖)。只在登录态翻转
  // 这一离散时刻把 draft 重新对齐服务端真值,否则模型列表/启用开关要等重新选中才更新,
  // 且后续自动保存会把过期的 enabled 回写。
  const signedIn = selected?.oauthStatus?.signedIn === true;
  const lastSignedInRef = React.useRef(signedIn);
  React.useEffect(() => {
    if (lastSignedInRef.current === signedIn) return;
    lastSignedInRef.current = signedIn;
    if (!selected) return;
    setDraft(clone(selected));
    // discard 而非 reset:reset 会把防抖窗口内的脏编辑「补发」出去,而此处的补发拿到的
    // 仍是上一次渲染的 save 闭包(setDraft 尚未重渲染),POST 的是登录前的旧 draft——
    // 服务端护栏只保护 oauth/authMode,models/enabled 会被旧值覆盖(刚登录铺好的捆绑
    // 模型丢失、enabled 可能被写回 false)。登录态翻转即以服务端真值为准,旧编辑必须丢弃。
    void autosave.discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, selected?.id]);

  if (!draft) return null;
  const balanceOption = balanceOptionOf(draft);
  const kind = providerKind(draft) as ProviderKind;

  const patchDraft = (patch: Partial<ProviderProfile>) => {
    autosave.markDirty();
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  // 测试/查余额前的"确保服务端拿到当前草稿"。force:与原实现一致,无条件落一次。
  const save = () => autosave.saveNow({ force: true });
  const fetchModels = async () => {
    // 订阅供应商:凭据在服务端 oauth 里,前端 apiKey 恒空——闸门看 oauthStatus 而非 apiKey。
    if (draft.authMode !== "oauth" && !textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_fetch"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      setFetchedModels(result.models);
      toast.success(t("settings:providers.fetched_models", { count: result.models.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:providers.fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const handleToggleEnabled = async (enabled: boolean) => {
    // 关闭：直接关
    if (!enabled) {
      patchDraft({ enabled: false });
      return;
    }
    // 已有已启用模型（历史 / 用户此前已勾选）：直接启用，不自动拉取
    if ((draft.models ?? []).length > 0) {
      patchDraft({ enabled: true });
      return;
    }
    // 空列表：先持久化当前配置（让服务端拿到最新 baseUrl / apiKey），再拉取上游模型
    // 订阅供应商:凭据在服务端 oauth 里,前端 apiKey 恒空——闸门看 oauthStatus 而非 apiKey。
    if (draft.authMode !== "oauth" && !textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_enable"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      if (!result.models.length) {
        toast.error(t("settings:providers.no_models_enable"));
        return;
      }
      // 与单个勾选时一致地分类 CHAT / IMAGE / EMBEDDING
      const models = result.models.map(applyAutoModelType);
      setFetchedModels(result.models);
      patchDraft({ enabled: true, models });
      toast.success(t("settings:providers.enabled_models", { count: models.length }));
    } catch (error) {
      // 不 patch enabled —— 保持关闭
      toast.error(error instanceof Error ? error.message : t("settings:providers.enable_fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const checkBalance = async () => {
    setCheckingBalance(true);
    setBalanceResult(t("settings:providers.balance_querying"));
    try {
      await save();
      const result = await api.post<{ value: string; endpoint: string; preview: string }>(
        "settings/provider/balance",
        { providerId: draft.id },
        { timeout: false },
      );
      setBalanceResult(t("settings:providers.balance_done", { value: result.value, endpoint: result.endpoint, preview: result.preview }));
      toast.success(t("settings:providers.balance_ok", { value: result.value }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.balance_failed");
      setBalanceResult(message);
      toast.error(message);
    } finally {
      setCheckingBalance(false);
    }
  };
  const addProvider = async () => {
    const next = createProvider();
    next.name = t("settings:providers.custom_name");
    next.shortDescription = t("settings:providers.custom_desc");
    await api.post("settings/provider", next);
    patchSettingsLocal((current) => ({ providers: upsertById(current.providers, next) }));
    setSelectedId(next.id);
    toast.success(t("settings:providers.added"));
  };
  const moveProvider = async (from: number, to: number) => {
    const nextProviders = moveItem(settings.providers, from, to);
    patchSettingsLocal({ providers: nextProviders });
    await api.post("settings/provider/reorder", {
      ids: nextProviders.map((provider) => provider.id),
    });
  };

  const isOauth = draft.authMode === "oauth";
  // 收起时高级区里有非默认配置就亮小圆点,免得默认折叠把用户自己的配置藏起来。
  const advancedAttention =
    (!isOauth &&
      kind === "openai" &&
      (hasCustomEndpointPath(draft) || draft.includeHistoryReasoning === false || draft.promptCacheKey === true)) ||
    (!isOauth && kind === "claude" && draft.promptCaching === true) ||
    (!isOauth && kind === "google" && draft.useInteractionsApi === true) ||
    balanceOption.enabled === true;
  const getKeyUrl = providerGetKeyUrl(textValue(draft.baseUrl));
  const resultPathValid = isBalanceResultPathValid(textValue(balanceOption.resultPath));

  const changeKind = (value: ProviderKind, useResponseApi?: boolean) => {
    // 类型切换也是编辑,必须置脏,否则永不自动保存(复审 F3 补获)
    autosave.markDirty();
    const next: ProviderProfile = {
      ...normalizeKindPatch(draft, value),
      ...(useResponseApi !== undefined ? { useResponseApi } : {}),
    };
    // 按登记表/协议默认换算过地址时告知用户去向;自定义地址不动则不打扰。端点尾缀在折叠区里,
    // 被静默归位时一并说明。
    const baseChanged = next.baseUrl !== textValue(draft.baseUrl) && textValue(draft.baseUrl) !== "";
    const pathReset = hasCustomEndpointPath(draft);
    if (baseChanged || pathReset) {
      toast(
        [
          baseChanged ? t("settings:providers.base_url_switched", { url: next.baseUrl }) : null,
          pathReset ? t("settings:providers.path_reset_on_kind") : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    setDraft(next);
  };

  // 已是 OpenAI 格式时只换协议(地址、尾缀都不动);从别的格式进来走完整的格式切换。
  const selectOpenAiFormat = (useResponseApi: boolean) => {
    if (kind !== "openai") {
      changeKind("openai", useResponseApi);
      return;
    }
    if ((draft.useResponseApi === true) !== useResponseApi) patchDraft({ useResponseApi });
  };

  const kindItems = PROVIDER_KINDS.map((value) =>
    value === "openai"
      ? {
          value,
          label: t(KIND_LABEL_KEYS[value]),
          wrap: (button: React.ReactElement) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-(--radix-dropdown-menu-trigger-width)">
                {OPENAI_FORMATS.map((format) => {
                  const active = kind === "openai" && (draft.useResponseApi === true) === format.responseApi;
                  return (
                    <DropdownMenuItem
                      key={String(format.responseApi)}
                      data-active={active || undefined}
                      onSelect={() => selectOpenAiFormat(format.responseApi)}
                    >
                      <span className="flex w-[18px] shrink-0 items-center justify-center">
                        {active ? <Check className="size-4 !text-current" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{t(format.labelKey)}</span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ),
        }
      : { value, label: t(KIND_LABEL_KEYS[value]) },
  );

  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。至少保留一个供应商。
  const deleteProviderById = async (targetId: string) => {
    if (settings.providers.length <= 1) return;
    const target = settings.providers.find((item) => item.id === targetId);
    if (!target) return;
    if (!(await confirmDialog({ title: t("settings:providers.delete_confirm", { name: target.name }), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard(丢脏编辑+等在飞保存,DELETE 不与迟到 POST 乱序)。
    const removingActive = draft.id === targetId;
    if (removingActive) await autosave.discard();
    await api.delete(`settings/provider/${encodeURIComponent(targetId)}`);
    let nextId = "";
    patchSettingsLocal((current) => {
      const providers = current.providers.filter((item) => item.id !== targetId);
      nextId = providers[0]?.id ?? "";
      return { providers };
    });
    // 删的是当前编辑行:选中下一个;删的是别的行:选中保持不动。
    if (removingActive) setSelectedId(nextId);
    toast.success(t("settings:providers.deleted"));
  };

  return (
    <SettingsSplit
      scroll
      list={
        <div className="space-y-1">
          <SettingsListAddButton label={t("settings:providers.add")} onClick={() => void addProvider()} />
          {settings.providers.map((provider, index) => (
            <SettingsListRow
              key={provider.id}
              id={provider.id}
              index={index}
              active={provider.id === draft.id}
              onSelect={() => setSelectedId(provider.id)}
              onMove={moveProvider}
              // 至少保留一个供应商:只剩一个时不给删除菜单(否则菜单在、点了却没有反应)。
              onDelete={settings.providers.length > 1 ? () => deleteProviderById(provider.id) : undefined}
              badge={
                provider.authMode === "oauth" ? (
                  <StatusBadge tone="brand">{t("settings:providers.oauth.badge")}</StatusBadge>
                ) : null
              }
            >
              <span className="grid min-w-0 grid-cols-[28px_10px_minmax(0,1fr)] items-center gap-2 text-left">
                <AIIcon name={provider.name} size={24} className="justify-self-start" />
                <span
                  className={`size-2 rounded-full ${provider.enabled ? "bg-success" : "bg-muted-foreground/40"}`}
                />
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
              </span>
            </SettingsListRow>
          ))}
        </div>
      }
    >
      <div className="@container">
        <SettingsStack>
          <SettingsDetailHeader
            title={draft.name}
            titlePlaceholder={t(providerFormatLabelKey(kind, draft))}
            titleLabel={t("settings:providers.name")}
            onTitleCommit={(name) => patchDraft({ name })}
            description={textValue(draft.shortDescription) || t(providerFormatLabelKey(kind, draft))}
            action={
              <label className="flex items-center gap-2 text-sm text-[var(--ds-text-secondary)]">
                {t("settings:providers.enabled_label")}
                <Switch
                  checked={draft.enabled}
                  disabled={fetchingModels}
                  onCheckedChange={(enabled) => void handleToggleEnabled(enabled)}
                />
              </label>
            }
          />

          <SettingsGroup title={t("settings:providers.connection_title")} fields>
            {!isOauth ? (
              <>
                <SettingsField label={t("settings:providers.type")}>
                  <SegmentedControl
                    stretch
                    aria-label={t("settings:providers.type")}
                    items={kindItems}
                    value={kind}
                    onChange={changeKind}
                  />
                </SettingsField>
                <SettingsField
                  label="Base URL"
                  hint={
                    <span className="block space-y-0.5 break-all">
                      <span className="block">{t("settings:providers.chat_url", { url: endpointPreview(draft) })}</span>
                      <span className="block">
                        {t("settings:providers.models_url", { url: modelListEndpointPreview(draft) })}
                      </span>
                    </span>
                  }
                >
                  <Input
                    value={textValue(draft.baseUrl)}
                    onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                    placeholder={DEFAULT_BASE_URLS[kind]}
                  />
                </SettingsField>
              </>
            ) : null}
            {isOauth ? (
              // 登录态读 SSE 真值(selected)而非 draft:draft 只在切换供应商/登录态翻转时重对齐,
              // 用 draft 会让卡片在登出/登录后仍停留在旧状态。
              // key 绑 provider.id:切换供应商时强制重挂载,清掉上次残留的 manualCode/textInput/
              // 已打开授权 URL 等瞬态——否则 A 供应商输入的授权码会带进 B 的登录框。
              <ProviderLoginPanel key={(selected ?? draft).id} provider={selected ?? draft} />
            ) : (
              <SettingsField
                label="API Key"
                trailing={
                  getKeyUrl ? (
                    <button
                      type="button"
                      onClick={() => void openExternal(getKeyUrl)}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      title={t("settings:providers.get_key_title")}
                    >
                      <ExternalLink className="size-3" />
                      {t("settings:providers.get_key")}
                    </button>
                  ) : undefined
                }
              >
                <PasswordInput value={textValue(draft.apiKey)} onChange={(apiKey) => patchDraft({ apiKey })} />
              </SettingsField>
            )}
          </SettingsGroup>


          <ProviderModelList
            key={`models:${draft.id}`}
            draft={draft}
            fetchedModels={fetchedModels}
            fetching={fetchingModels}
            onFetch={() => void fetchModels()}
            patchDraft={patchDraft}
            focusModelId={draft.id === deepLink.providerId ? deepLink.modelId : ""}
          />

          <ProviderTestPanel
            key={`test:${draft.id}`}
            draft={draft}
            fetchedModels={fetchedModels}
            onBeforeTest={save}
            onSettings={onSettings}
          />


          <SettingsAdvancedSection open={advancedOpen} onOpenChange={setAdvancedOpen} attention={advancedAttention}>
            <SettingsRows>
              {!isOauth && kind === "openai" ? (
                // 尾缀随所选协议绑定字段(对齐安卓 ProviderConfigure):Chat Completions→
                // chatCompletionsPath,Responses API→responsesPath。
                <div className="py-3">
                  <SettingsField
                    label={
                      draft.useResponseApi === true
                        ? t("settings:providers.responses_path_label")
                        : t("settings:providers.chat_completions_path_label")
                    }
                  >
                    <Input
                      value={
                        draft.useResponseApi === true
                          ? textValue(draft.responsesPath) || "/responses"
                          : textValue(draft.chatCompletionsPath) || defaultPathForKind(kind)
                      }
                      onChange={(event) =>
                        patchDraft(
                          draft.useResponseApi === true
                            ? { responsesPath: event.target.value }
                            : { chatCompletionsPath: event.target.value },
                        )
                      }
                    />
                  </SettingsField>
                </div>
              ) : null}
              {!isOauth && kind === "openai" ? (
                <SettingsSwitchRow
                  label={t("settings:providers.history_reasoning_title")}
                  description={t("settings:providers.history_reasoning_desc")}
                  checked={draft.includeHistoryReasoning !== false}
                  onCheckedChange={(includeHistoryReasoning) => patchDraft({ includeHistoryReasoning })}
                />
              ) : null}
              {!isOauth && kind === "openai" ? (
                <SettingsSwitchRow
                  label={t("settings:providers.prompt_cache_key_title")}
                  description={t("settings:providers.prompt_cache_key_desc")}
                  checked={draft.promptCacheKey === true}
                  onCheckedChange={(promptCacheKey) => patchDraft({ promptCacheKey })}
                />
              ) : null}
              {!isOauth && kind === "google" ? (
                <SettingsSwitchRow
                  label={t("settings:providers.interactions_title")}
                  description={t("settings:providers.interactions_desc")}
                  checked={draft.useInteractionsApi === true}
                  onCheckedChange={(useInteractionsApi) => patchDraft({ useInteractionsApi })}
                />
              ) : null}
              {!isOauth && kind === "claude" ? (
                <SettingsSwitchRow
                  label={t("settings:providers.prompt_cache_title")}
                  description={t("settings:providers.prompt_cache_desc")}
                  checked={draft.promptCaching === true}
                  onCheckedChange={(promptCaching) => patchDraft({ promptCaching })}
                >
                  {draft.promptCaching === true ? (
                    <SettingsField label={t("settings:providers.cache_ttl")}>
                      <Select
                        value={textValue(draft.promptCacheTtl) || "5m"}
                        onValueChange={(promptCacheTtl) => patchDraft({ promptCacheTtl: promptCacheTtl as "5m" | "1h" })}
                      >
                        <SelectTrigger className="w-full max-w-60" aria-label={t("settings:providers.cache_ttl")}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="5m">{t("settings:providers.cache_5m")}</SelectItem>
                          <SelectItem value="1h">{t("settings:providers.cache_1h")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingsField>
                  ) : null}
                </SettingsSwitchRow>
              ) : null}
              <SettingsSwitchRow
                label={t("settings:providers.balance_title")}
                description={t("settings:providers.balance_desc")}
                checked={balanceOption.enabled === true}
                onCheckedChange={(enabled) => patchDraft({ balanceOption: { ...balanceOptionOf(draft), enabled } })}
              >
                {balanceOption.enabled === true ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 @xl:grid-cols-2">
                      <SettingsField label={t("settings:providers.balance_api_path")}>
                        <Input
                          value={textValue(balanceOption.apiPath) || "/credits"}
                          onChange={(event) =>
                            patchDraft({ balanceOption: { ...balanceOptionOf(draft), apiPath: event.target.value } })
                          }
                        />
                      </SettingsField>
                      <SettingsField
                        label={t("settings:providers.balance_result_path")}
                        hint={
                          resultPathValid ? undefined : (
                            <span className="text-destructive">
                              {t("settings:providers.balance_result_path_invalid")}
                            </span>
                          )
                        }
                      >
                        <Input
                          value={textValue(balanceOption.resultPath)}
                          onChange={(event) =>
                            patchDraft({ balanceOption: { ...balanceOptionOf(draft), resultPath: event.target.value } })
                          }
                          aria-invalid={!resultPathValid}
                        />
                      </SettingsField>
                    </div>
                    <Button
                      type="button"
                      variant="tertiary"
                      size="compact"
                      onClick={() => void checkBalance()}
                      disabled={checkingBalance}
                    >
                      {checkingBalance ? <Loader2 className="animate-spin" /> : <Database />}
                      {t("settings:providers.query")}
                    </Button>
                    {balanceResult ? (
                      <pre className="max-h-56 overflow-auto rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] p-3 text-xs whitespace-pre-wrap">
                        {balanceResult}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </SettingsSwitchRow>
            </SettingsRows>
          </SettingsAdvancedSection>

          <SettingsDetailFooter
            status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
          />
        </SettingsStack>
      </div>
    </SettingsSplit>
  );
}
