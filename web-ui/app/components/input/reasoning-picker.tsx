import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import {
  Brain,
  BrainCircuit,
  Check,
  Lightbulb,
  LightbulbOff,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { useCurrentModel } from "~/hooks/use-current-model";
import { extractErrorMessage } from "~/lib/error";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { ProviderModel } from "~/types";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "~/components/ui/dropdown-menu";

// 思考强度(前端重构R2,对齐参考项目):不再是弹层底部的滑杆折叠区,而是模型级联
// 菜单里的一个子菜单项(ReasoningSubmenu)——父行显示"思考强度 · 当前档",子菜单
// 是单选列表。Radix DropdownMenuSub 原生处理子菜单定位与碰撞翻转,彻底规避了
// 旧方案滑杆撑高弹层导致超出窗口顶部的 bug。模型胶囊经 useCurrentReasoningLabel
// 显示"模型名 · 强度"后缀。

type ReasoningLevel = "off" | "auto" | "low" | "medium" | "high" | "xhigh" | "max";

/** 持久化值与 locale 键的归一边界：数据层允许大写枚举（AUTO/OFF…，与 Android 对齐的
 *  存储格式，跨端备份依赖它），展示层所有键拼接与档位对比必须先过这里。 */
function normalizeLevel(level: string | null | undefined): ReasoningLevel | null {
  const normalized = String(level ?? "").toLowerCase();
  return (REASONING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningLevel)
    : null;
}

const REASONING_LEVELS: ReasoningLevel[] = ["off", "auto", "low", "medium", "high", "xhigh", "max"];

interface ReasoningPreset {
  key: ReasoningLevel;
  label: string;
}

function isReasoningModel(model: ProviderModel | null): boolean {
  if (!model) return false;
  // The model.abilities array is authoritative: backend `enrichModel` infers it on fetch, the
  // startup migration backfills stale state, and the provider settings UI lets users override
  // by hand. Honor the user's choice — don't fall back to an id heuristic that could override
  // an explicit unselect.
  return (model.abilities ?? []).includes("REASONING");
}

function ReasoningIcon({ level, className }: { level: ReasoningLevel; className?: string }) {
  const props = { className: cn("size-4", className) };
  switch (level) {
    case "off":
      return <LightbulbOff {...props} />;
    case "auto":
      return <Sparkles {...props} />;
    case "low":
      return <Lightbulb {...props} />;
    case "medium":
      return <Lightbulb {...props} />;
    case "high":
      return <BrainCircuit {...props} />;
    case "xhigh":
      return <Brain {...props} />;
    case "max":
      return <BrainCircuit {...props} />;
  }
}

function useReasoningPresets(): ReasoningPreset[] {
  const { t } = useTranslation("input");
  return React.useMemo<ReasoningPreset[]>(
    () =>
      REASONING_LEVELS.map((key) => ({
        key,
        label: t(`reasoning.presets.${key}.label`),
      })),
    [t],
  );
}

/** 当前思考强度的展示标签;模型不支持推理时返回 null(模型胶囊隐藏后缀)。 */
export function useCurrentReasoningLabel(): string | null {
  const { t } = useTranslation("input");
  const { currentAssistant } = useCurrentAssistant();
  const { currentModel } = useCurrentModel();
  if (!isReasoningModel(currentModel)) return null;
  const level = normalizeLevel(currentAssistant?.reasoningLevel) ?? "auto";
  return t(`reasoning.presets.${level}.label`);
}

export interface ReasoningSubmenuProps {
  disabled?: boolean;
}

/** 模型级联菜单里的思考强度子菜单(参考项目 ModelSelector 的 thinkingMenuItem 形态)。 */
export function ReasoningSubmenu({ disabled = false }: ReasoningSubmenuProps) {
  const { t } = useTranslation("input");
  const { currentAssistant } = useCurrentAssistant();
  const { currentModel } = useCurrentModel();
  const reasoningPresets = useReasoningPresets();

  const canUse = Boolean(currentAssistant && !disabled);
  const canReasoning = isReasoningModel(currentModel);

  const currentLevel = normalizeLevel(currentAssistant?.reasoningLevel) ?? "auto";
  const currentPreset =
    reasoningPresets.find((preset) => preset.key === currentLevel) ?? reasoningPresets[1];

  const updateReasoningLevelMutation = useMutation({
    mutationFn: ({
      assistantId,
      reasoningLevel,
    }: {
      assistantId: string;
      reasoningLevel: ReasoningLevel;
    }) =>
      api.post<{ status: string }>("settings/assistant/thinking-budget", {
        assistantId,
        reasoningLevel,
      }),
    onError: (updateError) => {
      toast.error(extractErrorMessage(updateError, t("reasoning.update_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
    },
  });
  const loading = updateReasoningLevelMutation.isPending;

  if (!canReasoning) return null;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!canUse || loading}>
        <ReasoningIcon level={currentLevel} />
        <span className="flex-1">{t("reasoning.title")}</span>
        <span className="shrink-0 text-[var(--ds-text-tertiary)]">
          {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : currentPreset.label}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[200px]">
        {reasoningPresets.map((preset) => {
          const active = preset.key === currentLevel;
          return (
            <DropdownMenuItem
              key={preset.key}
              data-active={active || undefined}
              disabled={!canUse || loading}
              onSelect={() => {
                if (!currentAssistant || preset.key === currentLevel) return;
                updateReasoningLevelMutation.mutate({
                  assistantId: currentAssistant.id,
                  reasoningLevel: preset.key,
                });
              }}
            >
              <span className="flex w-[18px] shrink-0 items-center justify-center">
                {active ? <Check className="size-4 !text-current" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{preset.label}</span>
            </DropdownMenuItem>
          );
        })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
