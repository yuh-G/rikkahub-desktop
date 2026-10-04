// components/settings/providers/model-list.tsx — 供应商详情 › 模型:启用勾选、能力徽标、搜索 + 全选、
// 新增/编辑模型对话框。按供应商 key 重挂载,切换供应商即清空搜索词。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { SearchInput } from "~/components/ui/search-input";
import { StatusBadgeButton } from "~/components/ui/status-badge";
import { ModelEditDialog } from "~/components/model-edit-dialog";
import { createId } from "~/lib/id";
import { getModelDisplayName } from "~/lib/display";
import { cn } from "~/lib/utils";
import type { ProviderModel, ProviderProfile } from "~/types";
import { SettingsEmpty, SettingsGroup } from "~/components/settings/shared";
import { applyAutoModelType } from "~/components/settings/providers/common";

// ── Manual-models cache (in-memory, per provider) ────────────────────────────
// Only manually-added models (manuallyAdded === true) are cached here — fetched models are
// NOT. The point: a manual model has no upstream source to re-fetch from, so once the user
// creates it we must never let it vanish from the list just because they toggled it off (or
// navigated away and back, which clears the in-memory fetchedModels state). Toggling a
// manual model off removes it from draft.models (the enabled list) but it stays here, so the
// row remains visible with a dimmed checkbox. Fetched models keep their original behavior:
// off + a page switch → gone (the user can just re-fetch).
//
// Module scope ⇒ survives component unmount (page/provider switches) but not an app restart.
// On restart we fall back to draft.models; a manual model that was toggled off (and thus not
// in draft.models) is lost — accepted, since this is an in-memory-only convenience.
const manualModelsByProvider = new Map<string, Map<string, ProviderModel>>();

function rememberManualModel(providerId: string, model: ProviderModel): void {
  let bucket = manualModelsByProvider.get(providerId);
  if (!bucket) {
    bucket = new Map();
    manualModelsByProvider.set(providerId, bucket);
  }
  // Keep the identity-stable id on update; refresh everything else from the incoming model
  // so edits (display name, abilities, …) propagate to the cached copy too.
  const existing = bucket.get(model.modelId);
  bucket.set(model.modelId, existing ? { ...existing, ...model, id: existing.id } : model);
}

function forgetManualModel(providerId: string, modelId: string): void {
  manualModelsByProvider.get(providerId)?.delete(modelId);
}

// Single model dialog instance reused for both add (+ button) and edit (row click). The mode +
// modelIdLocked flags determine the dialog UX. State is reset every time the dialog opens
// (see ModelEditDialog's useEffect on `open`), so reusing one instance is safe.
type ModelDialogState = {
  mode: "add" | "edit";
  model: ProviderModel;
  modelIdLocked: boolean;
};

export function ProviderModelList({
  draft,
  fetchedModels,
  fetching,
  onFetch,
  patchDraft,
  focusModelId,
}: {
  draft: ProviderProfile;
  fetchedModels: ProviderModel[];
  fetching: boolean;
  onFetch: () => void;
  patchDraft: (patch: Partial<ProviderProfile>) => void;
  /** 深链高亮的模型 id / modelId(只属于深链指向的那个供应商);空串 = 无。 */
  focusModelId: string;
}) {
  const { t } = useTranslation();
  // Free-text filter for the model list.
  const [modelFilter, setModelFilter] = React.useState("");
  const [modelDialog, setModelDialog] = React.useState<ModelDialogState | null>(null);
  // 深链高亮的模型行只滚动进视野一次(列表限高,靠后的模型否则在可视区外)。
  const focusScrolledRef = React.useRef(false);
  const selectedModelIds = new Set((draft.models ?? []).map((model) => model.modelId));
  // Display source: merge fetchedModels with draft.models, deduping by modelId. Fetched
  // entries win on overlap (canonical upstream view); manually-added extras are appended.
  // Persisted per-row customizations are still applied downstream via the `persisted` lookup.
  // Manual models that were toggled off (absent from draft.models) are re-merged from the
  // in-memory manual cache so they stay visible instead of disappearing — see
  // manualModelsByProvider above. Fetched models are NOT cached: toggled off + a page switch
  // still clears them (re-fetch to bring them back), preserving the original behavior.
  const displayModels: ProviderModel[] = (() => {
    const fetched = fetchedModels;
    const drafts = draft.models ?? [];
    const fetchedIds = new Set(fetched.map((m) => m.modelId));
    // Start from fetched (canonical) + drafts not in fetched.
    const base = fetched.length === 0 ? drafts : [...fetched, ...drafts.filter((m) => !fetchedIds.has(m.modelId))];
    // Re-add cached manual models that have dropped out of draft.models (toggled off).
    const baseIds = new Set(base.map((m) => m.modelId));
    const cachedManual = manualModelsByProvider.get(draft.id);
    const danglingManual = cachedManual
      ? Array.from(cachedManual.values()).filter((m) => !baseIds.has(m.modelId))
      : [];
    const merged = danglingManual.length > 0 ? [...base, ...danglingManual] : base;
    // Manual models float to the top — they're user-authored (no upstream source) and tend to
    // be the ones the user cares about most; newly-added ones already sit at the head of
    // draft.models, so this surfaces them immediately instead of burying them under the
    // fetched list. Stable order preserved within each group.
    if (merged.length <= 1) return merged;
    const manual: ProviderModel[] = [];
    const rest: ProviderModel[] = [];
    for (const model of merged) {
      (model.manuallyAdded === true ? manual : rest).push(model);
    }
    return manual.length > 0 ? [...manual, ...rest] : rest;
  })();
  // Free-text filter (name or id). Applied on top of displayModels for the list view.
  const visibleModels = (() => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return displayModels;
    return displayModels.filter(
      (model) =>
        (model.displayName ?? "").toLowerCase().includes(query) ||
        (model.modelId ?? "").toLowerCase().includes(query),
    );
  })();
  // Whether every currently-visible (filtered) model is already enabled — drives the
  // select-all toggle label + click behavior. Acts on visibleModels, not the full set,
  // so "select filtered" works intuitively when searching.
  const allFilteredEnabled =
    visibleModels.length > 0 && visibleModels.every((model) => selectedModelIds.has(model.modelId));
  const toggleModel = (model: ProviderModel, checked: boolean) => {
    const models = checked
      ? // Auto-fill type for newly enabled models (CHAT/IMAGE/EMBEDDING) — user can override per-row.
        [...(draft.models ?? []), applyAutoModelType(model)].filter(
          (item, index, arr) => arr.findIndex((x) => x.modelId === item.modelId) === index,
        )
      : (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
    patchDraft({ models });
  };
  const toggleModelAbility = (modelId: string, ability: "TOOL" | "REASONING", enabled: boolean) => {
    const models = (draft.models ?? []).map((item) => {
      if (item.modelId !== modelId) return item;
      const current = Array.isArray(item.abilities) ? item.abilities : [];
      const next = enabled
        ? Array.from(new Set([...current, ability]))
        : current.filter((value) => value !== ability);
      return { ...item, abilities: next };
    });
    patchDraft({ models });
  };
  // Batch enable/disable for the "select all" toolbar. Acts on a given set of models
  // (the currently-visible filtered set): enable adds any missing ones (auto-typed),
  // disable removes them. Mirrors toggleModel's dedupe + applyAutoModelType semantics.
  const setModelsEnabled = (modelsToToggle: ProviderModel[], enabled: boolean) => {
    const ids = new Set(modelsToToggle.map((model) => model.modelId));
    if (enabled) {
      const existingIds = new Set((draft.models ?? []).map((model) => model.modelId));
      const additions = modelsToToggle
        .filter((model) => !existingIds.has(model.modelId))
        .map(applyAutoModelType);
      if (additions.length === 0) return;
      patchDraft({ models: [...(draft.models ?? []), ...additions] });
    } else {
      const remaining = (draft.models ?? []).filter((model) => !ids.has(model.modelId));
      if (remaining.length === (draft.models ?? []).length) return;
      patchDraft({ models: remaining });
    }
  };
  const openAddModelDialog = () => {
    const uuid = createId();
    setModelDialog({
      mode: "add",
      modelIdLocked: false,
      model: {
        id: uuid,
        modelId: "",
        displayName: "",
        type: "CHAT",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        abilities: [],
        tools: [],
        customHeaders: [],
        customBodies: [],
        manuallyAdded: true,
      },
    });
  };

  const openEditModelDialog = (model: ProviderModel) => {
    // Prefer the persisted entry (with the user's prior customizations) over the fetched one.
    // If model isn't enabled yet, fall back to the fetched row — saving will auto-enable.
    const persisted = (draft.models ?? []).find((item) => item.modelId === model.modelId);
    const source = persisted ?? model;
    // Manually-added models keep ID editable; everything else (fetched, legacy) is locked
    // because the modelId is sent verbatim to the upstream API and editing it would silently
    // break request routing. See pc-server/inference-engine/providers.ts.
    const isManual = source.manuallyAdded === true;
    setModelDialog({
      mode: "edit",
      modelIdLocked: !isManual,
      model: { ...source },
    });
  };

  const handleModelDialogSave = (model: ProviderModel) => {
    if (!modelDialog) return;
    const existing = (draft.models ?? []).find((item) => item.id === model.id);
    let models: ProviderModel[];
    if (existing) {
      // Edit existing persisted model — replace by UUID id (stable across re-fetches).
      models = (draft.models ?? []).map((item) => (item.id === model.id ? model : item));
    } else if (modelDialog.mode === "add") {
      // Brand-new manual add — also reject duplicate modelId to avoid confusing dedup behavior
      // downstream (toggleModel matches by modelId, not id, so a clash would orphan the new one).
      const clash = (draft.models ?? []).some((item) => item.modelId === model.modelId);
      if (clash) {
        toast.error(t("settings:providers.model_id_exists", { id: model.modelId }));
        return;
      }
      models = [model, ...(draft.models ?? [])];
    } else {
      // Edit dialog opened on a fetched-but-not-yet-enabled row → save auto-enables.
      // Dedup by modelId in case the user toggled the checkbox in parallel.
      const without = (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
      models = [...without, model];
    }
    patchDraft({ models });
    // Cache manual models so toggling them off later doesn't erase them from the list
    // (they have no upstream source to re-fetch from). Also refreshes the cached copy on edit
    // so display-name/ability changes propagate. Fetched models are intentionally not cached.
    if (model.manuallyAdded === true) rememberManualModel(draft.id, model);
    toast.success(modelDialog.mode === "add" ? t("settings:providers.model_added") : t("settings:providers.model_saved"));
  };

  const handleModelDialogDelete = () => {
    if (!modelDialog) return;
    const target = modelDialog.model;
    // Remove by both id AND modelId to be safe — if the model came from a fetched row whose
    // id wasn't yet in draft.models, the id match alone wouldn't find anything.
    patchDraft({
      models: (draft.models ?? []).filter(
        (item) => item.id !== target.id && item.modelId !== target.modelId,
      ),
    });
    // Drop from the manual cache too, otherwise the deleted row would linger in the list.
    if (target.manuallyAdded === true) forgetManualModel(draft.id, target.modelId);
    toast.success(t("settings:providers.model_deleted"));
  };
  const selectAllLabel = allFilteredEnabled
    ? modelFilter
      ? t("settings:providers.models_deselect_all_filtered")
      : t("settings:providers.models_deselect_all")
    : modelFilter
      ? t("settings:providers.models_select_all_filtered")
      : t("settings:providers.models_select_all");
  const scrollFocusedIntoView = (element: HTMLDivElement | null) => {
    if (!element || focusScrolledRef.current) return;
    focusScrolledRef.current = true;
    element.scrollIntoView({ block: "nearest" });
  };

  return (
    <>
      <SettingsGroup
        title={t("settings:providers.models_title")}
        description={t("settings:providers.models_desc", { count: draft.models?.length ?? 0 })}
        action={
          <>
            <Button variant="tertiary" size="compact" onClick={openAddModelDialog} title={t("settings:providers.add_model_title")}>
              <Plus className="size-4" />
              {t("settings:providers.add_model")}
            </Button>
            <Button variant="tertiary" size="compact" onClick={onFetch} disabled={fetching}>
              {fetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {t("settings:providers.fetch_models")}
            </Button>
          </>
        }
        fields
      >
        {/* 搜索 + 全选工具条:列表为空(未拉取、无手动模型)时不显示。 */}
        {(fetchedModels.length > 0 || (draft.models ?? []).length > 0) && (
          <div className="flex items-center gap-2">
            <SearchInput
              className="flex-1"
              value={modelFilter}
              onValueChange={setModelFilter}
              placeholder={t("settings:providers.models_search_placeholder")}
              aria-label={t("settings:providers.models_search_placeholder")}
              clearLabel={t("settings:providers.clear_search")}
            />
            {/* 已启用/总数:当前过滤后还剩多少一目了然。 */}
            <span className="shrink-0 text-xs tabular-nums text-[var(--ds-text-secondary)]">
              {t("settings:providers.models_selection_count", {
                enabled: draft.models?.length ?? 0,
                total: displayModels.length,
              })}
            </span>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => setModelsEnabled(visibleModels, !allFilteredEnabled)}
              disabled={visibleModels.length === 0}
              title={selectAllLabel}
            >
              {selectAllLabel}
            </Button>
          </div>
        )}
        <div className="max-h-72 space-y-2 overflow-auto">
          {visibleModels.map((model) => {
              const focused =
                focusModelId !== "" && (model.modelId === focusModelId || model.id === focusModelId);
              const enabled = selectedModelIds.has(model.modelId);
              const persisted = (draft.models ?? []).find(
                (item) => item.modelId === model.modelId,
              );
              const currentType =
                (persisted?.type as "CHAT" | "IMAGE" | "EMBEDDING" | undefined) ?? "CHAT";
              const currentAbilities = Array.isArray(persisted?.abilities)
                ? persisted!.abilities
                : [];
              const hasTool = currentAbilities.includes("TOOL");
              const hasReasoning = currentAbilities.includes("REASONING");
              return (
                <div
                  key={model.id ?? model.modelId}
                  ref={focused ? scrollFocusedIntoView : undefined}
                  // The row itself is the click target for the edit dialog. The checkbox and
                  // ability buttons inside stop propagation so they keep their own semantics.
                  role="button"
                  tabIndex={0}
                  onClick={() => openEditModelDialog(model)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openEditModelDialog(model);
                    }
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] px-3 py-2 outline-none transition-colors duration-(--ds-duration-fast) ease-(--ds-ease-swift) hover:bg-[var(--ds-on-surface-active)] focus-visible:ring-2 focus-visible:ring-ring/50",
                    focused && "bg-[var(--ds-on-surface-active)] ring-2 ring-[var(--ds-brand-primary)]/40",
                  )}
                >
                  <span onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={enabled}
                      onCheckedChange={(checked) => toggleModel(model, checked === true)}
                    />
                  </span>
                  <AIIcon name={model.modelId} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {getModelDisplayName(model.displayName, model.modelId)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {model.modelId}
                    </span>
                  </span>
                  {enabled && currentType === "CHAT" ? (
                    <div className="flex items-center gap-1.5">
                      <StatusBadgeButton
                        tone="warning"
                        pressed={hasTool}
                        onClick={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                          toggleModelAbility(model.modelId, "TOOL", !hasTool);
                        }}
                        title={hasTool ? t("settings:providers.tool_enabled") : t("settings:providers.tool_disabled")}
                      >
                        {t("settings:providers.tool_short")}
                      </StatusBadgeButton>
                      <StatusBadgeButton
                        tone="brand"
                        pressed={hasReasoning}
                        onClick={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                          toggleModelAbility(model.modelId, "REASONING", !hasReasoning);
                        }}
                        title={hasReasoning ? t("settings:providers.reasoning_enabled") : t("settings:providers.reasoning_disabled")}
                      >
                        {t("settings:providers.reasoning_short")}
                      </StatusBadgeButton>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {displayModels.length === 0 ? (
              <SettingsEmpty>{t("settings:providers.no_models")}</SettingsEmpty>
            ) : visibleModels.length === 0 ? (
              <SettingsEmpty>{t("settings:providers.models_no_match")}</SettingsEmpty>
            ) : null}
        </div>
      </SettingsGroup>
      {modelDialog ? (
        <ModelEditDialog
          open={Boolean(modelDialog)}
          onOpenChange={(open) => {
            if (!open) setModelDialog(null);
          }}
          mode={modelDialog.mode}
          modelIdLocked={modelDialog.modelIdLocked}
          initialModel={modelDialog.model}
          onSave={handleModelDialogSave}
          onDelete={modelDialog.mode === "edit" ? handleModelDialogDelete : undefined}
        />
      ) : null}
    </>
  );
}
