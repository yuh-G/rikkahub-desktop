import * as React from "react";

import { Check, ChevronDown, Heart, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { ReasoningSubmenu, useCurrentReasoningLabel } from "~/components/input/reasoning-picker";
import { usePaneContainer } from "~/components/workspace/pane-container-context";
import { CHAT_CONTAINER } from "~/stores/container-tabs-store";
import { getModelDisplayName } from "~/lib/display";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { ProviderModel } from "~/types";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

// 模型选择(前端重构R2,复刻 NewMax ModelSelector):推翻 A2 的大弹层(供应商 chips+
// 模型卡列表+滑杆,会被推理区撑出窗口),改为紧凑级联菜单——供应商为父项、模型列表
// 是子菜单,末尾分割线+思考强度子菜单。Radix DropdownMenuSub 原生做碰撞翻转与
// 高度收敛,弹层溢出 bug 就此消除。收藏组置顶(NewMax 无此功能,保留我们的)。

export interface ModelListProps {
  disabled?: boolean;
  className?: string;
  onChanged?: (model: ProviderModel) => void;
}

interface ModelSection {
  providerId: string;
  providerName: string;
  models: ProviderModel[];
}

/** ds-menu-item 的左侧勾选槽(NewMax DsMenuItem 的 active 形态,18px 定宽)。 */
function CheckSlot({ active }: { active: boolean }) {
  return (
    <span className="flex w-[18px] shrink-0 items-center justify-center">
      {active ? <Check className="size-4 !text-current" /> : null}
    </span>
  );
}

function ModelMenuItem({
  model,
  selected,
  updating,
  favorite,
  disabled,
  onSelect,
  onToggleFavorite,
}: {
  model: ProviderModel;
  selected: boolean;
  updating: boolean;
  favorite: boolean;
  disabled: boolean;
  onSelect: (model: ProviderModel) => void | Promise<void>;
  onToggleFavorite: (model: ProviderModel) => void | Promise<void>;
}) {
  return (
    <DropdownMenuItem
      data-active={selected || undefined}
      disabled={disabled}
      className="group/model"
      onSelect={() => void onSelect(model)}
    >
      <CheckSlot active={selected} />
      <AIIcon name={model.modelId} size={16} className="bg-transparent" imageClassName="h-full w-full" />
      <span className="min-w-0 flex-1 truncate">
        {getModelDisplayName(model.displayName, model.modelId)}
      </span>
      {updating ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <span
          role="button"
          aria-pressed={favorite}
          className={cn(
            "ml-auto flex size-5 shrink-0 items-center justify-center rounded-full transition-opacity",
            favorite
              ? "!text-[var(--ds-brand-primary)]"
              : "opacity-0 group-hover/model:opacity-60 hover:!opacity-100",
          )}
          onPointerDown={(event) => {
            // 阻断 Radix 的 item 选中,收藏切换不关闭菜单、不切模型。
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void onToggleFavorite(model);
          }}
        >
          <Heart className={cn("size-3.5", favorite && "fill-current")} />
        </span>
      )}
    </DropdownMenuItem>
  );
}

export function ModelListImpl({ disabled = false, className, onChanged }: ModelListProps) {
  const { t } = useTranslation("input");
  const { settings, currentAssistant } = useCurrentAssistant();
  // 模型胶囊尾缀展示当前思考强度(NewMax 形态);菜单末尾是思考强度子菜单。
  const reasoningLabel = useCurrentReasoningLabel();

  const [updatingModelId, setUpdatingModelId] = React.useState<string | null>(null);

  const currentModelId = currentAssistant?.chatModelId ?? settings?.chatModelId ?? null;
  // Claude 订阅(Pro/Max,chatCapable=false)仅工作区可选:聊天列的选择器隐藏该供应商
  // (宿主引擎的 resolve 闸门同样拒绝),工作区列走 pi 引擎不经宿主闸门,照常展示。
  const paneContainer = usePaneContainer();
  const isWorkspacePane = paneContainer !== CHAT_CONTAINER;
  const favoriteModelIds = React.useMemo(
    () => settings?.favoriteModels ?? [],
    [settings?.favoriteModels],
  );
  const favoriteModelIdSet = React.useMemo(() => new Set(favoriteModelIds), [favoriteModelIds]);

  const allModels = React.useMemo(() => {
    if (!settings) return [];
    return settings.providers
      .filter(
        (provider) =>
          provider.enabled &&
          (isWorkspacePane || provider.oauthStatus?.chatCapable !== false),
      )
      .flatMap((provider) => provider.models)
      .filter((model) => model.type === "CHAT");
  }, [settings, isWorkspacePane]);

  const sections = React.useMemo<ModelSection[]>(() => {
    if (!settings) return [];
    return settings.providers
      .filter(
        (provider) =>
          provider.enabled &&
          (isWorkspacePane || provider.oauthStatus?.chatCapable !== false),
      )
      .map((provider) => ({
        providerId: provider.id,
        providerName: provider.name,
        models: provider.models.filter((model) => model.type === "CHAT"),
      }))
      .filter((section) => section.models.length > 0);
  }, [settings, isWorkspacePane]);

  const favoriteModels = React.useMemo(
    () =>
      favoriteModelIds
        .map((id) => allModels.find((model) => model.id === id))
        .filter((model): model is ProviderModel => model !== undefined),
    [favoriteModelIds, allModels],
  );

  const currentModel = React.useMemo(
    () => allModels.find((model) => model.id === currentModelId) ?? null,
    [allModels, currentModelId],
  );
  const currentProviderId = React.useMemo(
    () =>
      sections.find((section) => section.models.some((model) => model.id === currentModelId))
        ?.providerId ?? null,
    [sections, currentModelId],
  );

  const currentModelLabel = currentModel
    ? getModelDisplayName(currentModel.displayName, currentModel.modelId)
    : t("model_list.select_model");

  const handleSelectModel = React.useCallback(
    async (model: ProviderModel) => {
      if (disabled || !currentAssistant || model.id === currentModelId) return;

      setUpdatingModelId(model.id);
      try {
        await api.post<{ status: string }>("settings/assistant/model", {
          assistantId: currentAssistant.id,
          modelId: model.id,
        });
        await refreshSettingsStore();
        onChanged?.(model);
      } catch (changeError) {
        toast.error(
          changeError instanceof Error ? changeError.message : t("model_list.switch_model_failed"),
        );
      } finally {
        setUpdatingModelId(null);
      }
    },
    [currentAssistant, currentModelId, disabled, onChanged, t],
  );

  const handleToggleFavorite = React.useCallback(
    async (model: ProviderModel) => {
      if (disabled || !settings) return;

      const isFavorite = favoriteModelIds.includes(model.id);
      const newFavoriteModels = isFavorite
        ? favoriteModelIds.filter((id) => id !== model.id)
        : [...favoriteModelIds, model.id];

      try {
        await api.post<{ status: string }>("settings/favorite-models", {
          modelIds: newFavoriteModels,
        });
        await refreshSettingsStore();
      } catch (changeError) {
        toast.error(
          changeError instanceof Error
            ? changeError.message
            : t("model_list.update_favorites_failed"),
        );
      }
    },
    [disabled, favoriteModelIds, settings, t],
  );

  const renderModelItems = (models: ProviderModel[]) =>
    models.map((model) => (
      <ModelMenuItem
        key={model.id}
        model={model}
        selected={model.id === currentModelId}
        updating={model.id === updatingModelId}
        favorite={favoriteModelIdSet.has(model.id)}
        disabled={disabled || updatingModelId !== null}
        onSelect={handleSelectModel}
        onToggleFavorite={handleToggleFavorite}
      />
    ));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            // 容器查询而非视口断点:按输入卡实际宽度分级让位——视口断点在分栏下永远判"宽",
            // 标签撑爆工具条造成元素重叠(issue:分栏排版挤在一起)。
            // 分级:<42rem(典型分栏窗格)收起推理档与箭头、模型名限宽;<24rem(极窄)只留图标。
            // 模型名是工具条里最该保住的信息,故它最后一个才让位。
            "ds-icon-inherit h-8 max-w-64 shrink justify-start gap-1.5 rounded-full px-2.5 text-compact font-medium text-[var(--ds-icon)] hover:text-foreground @max-2xl/composer:max-w-32 @max-sm/composer:max-w-none @max-sm/composer:gap-0 @max-sm/composer:px-0",
            className,
          )}
          disabled={disabled || !currentAssistant}
        >
          <AIIcon
            name={currentModel?.modelId ?? "auto"}
            size={16}
            className="bg-transparent"
            imageClassName="h-full w-full"
          />
          <span className="min-w-0 flex-1 truncate text-left @max-sm/composer:hidden">
            {currentModelLabel}
          </span>
          {reasoningLabel ? (
            <span className="shrink-0 font-normal text-[var(--ds-text-tertiary)] @max-2xl/composer:hidden">
              {reasoningLabel}
            </span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 @max-2xl/composer:hidden" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[200px]">
        {sections.length === 0 ? (
          <div className="px-[10px] py-2 text-compact text-[var(--ds-text-tertiary)]">
            {t("model_list.empty")}
          </div>
        ) : (
          <>
            {favoriteModels.length > 0 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Heart className="size-4" />
                  <span className="flex-1">{t("model_list.favorites")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[240px] max-w-[420px]">
                  {renderModelItems(favoriteModels)}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {sections.map((section) => (
              <DropdownMenuSub key={section.providerId}>
                <DropdownMenuSubTrigger data-active={section.providerId === currentProviderId || undefined}>
                  <CheckSlot active={section.providerId === currentProviderId} />
                  <span className="min-w-0 flex-1 truncate">{section.providerName}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[240px] max-w-[420px]">
                  {renderModelItems(section.models)}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </>
        )}
        <ReasoningSubmenu disabled={disabled} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// memo:disabled/className/onChanged 在打字时不变,跳过重渲染。
export const ModelList = React.memo(ModelListImpl);
