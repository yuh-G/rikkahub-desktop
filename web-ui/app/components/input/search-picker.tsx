import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { ChevronDown, Earth, LoaderCircle, Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { useCurrentModel } from "~/hooks/use-current-model";
import { usePickerPopover } from "~/hooks/use-picker-popover";
import { extractErrorMessage } from "~/lib/error";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { BuiltInTool, ProviderModel, SearchServiceOption } from "~/types";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Switch } from "~/components/ui/switch";

import { PickerErrorAlert } from "./picker-error-alert";

const SEARCH_TOOL_NAME = "search";

const SEARCH_SERVICE_LABELS: Record<string, string> = {
  bing_local: "Bing",
  rikkahub: "RikkaHub",
  zhipu: "智谱",
  tavily: "Tavily",
  exa: "Exa",
  searxng: "SearXNG",
  linkup: "LinkUp",
  brave: "Brave",
  metaso: "秘塔",
  ollama: "Ollama",
  perplexity: "Perplexity",
  firecrawl: "Firecrawl",
  grok: "Grok",
  jina: "Jina",
  bocha: "博查",
  tinyfish: "Tinyfish",
  custom_js: "Custom JS",
};

export interface SearchPickerButtonProps {
  disabled?: boolean;
  className?: string;
}

function getToolType(tool: BuiltInTool | string | null | undefined): string | null {
  if (!tool) {
    return null;
  }

  if (typeof tool === "string") {
    return tool.trim().toLowerCase();
  }

  const value = tool.type;
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }

  return null;
}

function hasBuiltInSearch(tools: ProviderModel["tools"] | undefined): boolean {
  if (!tools || tools.length === 0) {
    return false;
  }

  return tools.some((tool) => getToolType(tool) === SEARCH_TOOL_NAME);
}

// Mirror Android's SearchPicker.kt:161 exactly — the built-in search toggle ONLY shows up for
// Gemini-family models or models whose id contains "gpt-". Android's predicate is:
//
//   if (ModelRegistry.GEMINI_SERIES.match(model.modelId) || model.modelId.contains("gpt-"))
//
// Earlier PC code aggressively included sonar/perplexity/grok/glm-4.5/etc. via a regex — that
// was invented, not ported, and ended up showing a dead toggle (the backend's hasBuiltInTool
// path is only consumed by Google's native search grounding + OpenAI's Responses API, so
// nothing else routes the option). Sticking to Android's predicate keeps the UI honest.
function isKnownBuiltInSearchModel(model: ProviderModel | null): boolean {
  if (!model) return false;
  const id = model.modelId.toLowerCase();
  if (id.includes("gpt-")) return true;
  // Gemini family detection mirrors ModelRegistry.GEMINI_SERIES (token-based: "gemini" in id).
  if (
    id === "gemini" ||
    id.startsWith("gemini-") ||
    id.includes("gemini-") ||
    id.includes("gemini_")
  )
    return true;
  return false;
}

function getServiceType(service: SearchServiceOption): string | null {
  if (typeof service.type !== "string") {
    return null;
  }

  const value = service.type.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

// A service shows up in the chat picker only when it's a preset (Bing/RikkaHub) or the user
// has run "测试" successfully on it. Mirrors Android, where unverified API keys never reach
// the chat. The `testPassed` flag is set/cleared by the backend in settings.tsx.
const ALWAYS_AVAILABLE_TYPES = new Set(["bing_local", "rikkahub"]);
function isServiceUsable(service: SearchServiceOption): boolean {
  const type = getServiceType(service);
  if (type && ALWAYS_AVAILABLE_TYPES.has(type)) return true;
  return (service as Record<string, unknown>).testPassed === true;
}

function getServiceLabel(service: SearchServiceOption, t: TFunction): string {
  const type = getServiceType(service);
  if (!type) {
    return t("search.default_service_label");
  }

  return SEARCH_SERVICE_LABELS[type] ?? type;
}

export function SearchPickerButtonImpl({ disabled = false, className }: SearchPickerButtonProps) {
  const { t } = useTranslation("input");
  const { settings, currentAssistant } = useCurrentAssistant();
  const { currentModel } = useCurrentModel();

  const canUse = Boolean(settings && currentAssistant && !disabled);
  const { error, setError, popoverProps } = usePickerPopover(canUse);

  const builtInSearchEnabled = hasBuiltInSearch(currentModel?.tools);
  const canUseBuiltInSearch = builtInSearchEnabled || isKnownBuiltInSearchModel(currentModel);
  const searchEnabled = settings?.enableWebSearch ?? false;
  const rawSelectedService = settings?.searchServices?.[settings.searchServiceSelected] ?? null;
  // Only use the selected service for the trigger button's logo when it's actually usable —
  // i.e. it's a preset (Bing/RikkaHub) or it has passed connection test. Otherwise rendering
  // the unverified provider's logo on the button is misleading: that service won't be used
  // during chat (isServiceUsable filters it out of the chat picker too). Fallback to the
  // generic Earth icon. Mirrors the chat picker's own usable-only filter.
  const currentService =
    rawSelectedService && isServiceUsable(rawSelectedService) ? rawSelectedService : null;
  const checked = searchEnabled || builtInSearchEnabled;

  React.useEffect(() => {
    if (!canUse) {
      popoverProps.onOpenChange(false);
    }
  }, [canUse]);

  const toggleSearchEnabledMutation = useMutation({
    mutationFn: ({ enabled }: { enabled: boolean }) =>
      api.post<{ status: string }>("settings/search/enabled", { enabled }),
    onError: (toggleError) => {
      setError(extractErrorMessage(toggleError, t("search.update_search_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const selectServiceMutation = useMutation({
    mutationFn: ({ index }: { index: number }) =>
      api.post<{ status: string }>("settings/search/service", { index }),
    onError: (serviceError) => {
      setError(extractErrorMessage(serviceError, t("search.switch_service_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const toggleBuiltInSearchMutation = useMutation({
    mutationFn: ({ modelId, enabled }: { modelId: string; enabled: boolean }) =>
      api.post<{ status: string }>("settings/model/built-in-tool", {
        modelId,
        tool: SEARCH_TOOL_NAME,
        enabled,
      }),
    onError: (toolError) => {
      setError(extractErrorMessage(toolError, t("search.update_builtin_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const loading =
    toggleSearchEnabledMutation.isPending ||
    toggleBuiltInSearchMutation.isPending ||
    selectServiceMutation.isPending;

  return (
    <Popover {...popoverProps}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canUse || loading}
          className={cn(
            "h-8 rounded-full px-2 text-muted-foreground hover:text-foreground",
            checked && "text-primary hover:bg-primary/10",
            className,
          )}
        >
          {toggleSearchEnabledMutation.isPending || toggleBuiltInSearchMutation.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : builtInSearchEnabled ? (
            // Match Android (HugeIcons.AiSearch02): a sparkle-themed search marker so the user
            // can tell at a glance that the model's own search is active, not the external one.
            <Sparkles className="size-4" />
          ) : searchEnabled && currentService ? (
            <AIIcon
              name={getServiceLabel(currentService, t)}
              size={16}
              className="bg-transparent"
              imageClassName="h-full w-full"
            />
          ) : (
            <Earth className="size-4" />
          )}
          <span className="hidden sm:block">
            <ChevronDown className="size-3.5" />
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(92vw,28rem)] gap-0 p-0">
        <PopoverHeader className="border-b px-6 py-4">
          <PopoverTitle>{t("search.title")}</PopoverTitle>
          <PopoverDescription>{t("search.description")}</PopoverDescription>
        </PopoverHeader>

        <div className="space-y-4 px-4 py-4">
          <PickerErrorAlert error={error} />

          {canUseBuiltInSearch ? (
            <div className="flex items-center gap-3 rounded-lg border px-3 py-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t("search.builtin_title")}</div>
                <div className="text-muted-foreground text-xs">{t("search.builtin_desc")}</div>
              </div>
              <Switch
                checked={builtInSearchEnabled}
                disabled={disabled || loading}
                onCheckedChange={(nextChecked) => {
                  if (!canUse || !currentModel) return;
                  toggleBuiltInSearchMutation.mutate({
                    modelId: currentModel.id,
                    enabled: nextChecked,
                  });
                }}
              />
            </div>
          ) : null}

          {/* Mirror Android's SearchPicker.kt:166 — the web-search card and service list are
              ONLY rendered when the model's built-in search is OFF. The two paths are mutually
              exclusive at the UI level so users can't accidentally configure both at once
              (the backend already uses built-in search when present and falls back to the
              external service otherwise, but Android hides the redundant settings entirely). */}
          {builtInSearchEnabled ? null : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border px-3 py-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Earth className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{t("search.web_title")}</div>
                  <div className="text-muted-foreground text-xs">
                    {searchEnabled ? t("search.status_enabled") : t("search.status_disabled")}
                  </div>
                </div>
                <Switch
                  checked={searchEnabled}
                  disabled={disabled || loading}
                  onCheckedChange={(nextChecked) => {
                    if (!canUse) return;
                    toggleSearchEnabledMutation.mutate({ enabled: nextChecked });
                  }}
                />
              </div>

              <ScrollArea className="h-[16rem] pr-3">
                {settings?.searchServices?.length ? (
                  (() => {
                    const visibleServices = settings.searchServices
                      .map((service, originalIndex) => ({ service, originalIndex }))
                      .filter(({ service }) => isServiceUsable(service));
                    if (visibleServices.length === 0) {
                      return (
                        <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                          没有可用的搜索服务。请前往设置 → 搜索服务，配置 API Key 并通过测试。
                        </div>
                      );
                    }
                    return (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {visibleServices.map(({ service, originalIndex }) => {
                          const selected = originalIndex === settings.searchServiceSelected;
                          const switching =
                            selectServiceMutation.isPending &&
                            selectServiceMutation.variables?.index === originalIndex;
                          const type = getServiceType(service);
                          const isPreset = type ? ALWAYS_AVAILABLE_TYPES.has(type) : false;
                          const passed =
                            isPreset || (service as Record<string, unknown>).testPassed === true;

                          return (
                            <button
                              key={service.id}
                              type="button"
                              className={cn(
                                "hover:bg-muted flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
                                selected && "border-primary bg-primary/5",
                              )}
                              disabled={disabled || loading}
                              onClick={() => {
                                if (
                                  !canUse ||
                                  !settings ||
                                  originalIndex === settings.searchServiceSelected
                                )
                                  return;
                                selectServiceMutation.mutate({ index: originalIndex });
                              }}
                            >
                              <AIIcon
                                name={getServiceLabel(service, t)}
                                size={20}
                                className="bg-transparent"
                                imageClassName="h-full w-full"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">
                                  {getServiceLabel(service, t)}
                                </div>
                                <div className="text-muted-foreground truncate text-xs">
                                  {type ?? t("search.unknown")}
                                </div>
                              </div>
                              <span
                                className={cn(
                                  "size-2 shrink-0 rounded-full",
                                  passed ? "bg-emerald-500" : "bg-muted-foreground/40",
                                )}
                                title={
                                  passed ? (isPreset ? "预置可用" : "已通过测试") : "未通过测试"
                                }
                              />
                              {switching ? (
                                <LoaderCircle className="size-3.5 animate-spin" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                    {t("search.empty")}
                  </div>
                )}
              </ScrollArea>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// memo:props 只有 disabled(布尔)+ className(常量字符串),输入框打字时不会变,
// 因此本组件能跳过重渲染,不随 ChatInput 的 value 变化一起重跑。
export const SearchPickerButton = React.memo(SearchPickerButtonImpl);
