import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, PackageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { usePickerPopover } from "~/hooks/use-picker-popover";
import { getDisplayName } from "~/lib/display";
import { extractErrorMessage } from "~/lib/error";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { safeStringArray } from "~/lib/type-guards";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { LorebookProfile, ModeInjectionProfile, QuickMessage } from "~/types";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";

import { PickerErrorAlert } from "./picker-error-alert";

export interface ExtensionPickerButtonProps {
  disabled?: boolean;
  className?: string;
}

function getModeInjections(source: unknown): ModeInjectionProfile[] {
  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((item): item is ModeInjectionProfile =>
    Boolean(item && typeof item === "object" && typeof item.id === "string"),
  );
}

function getLorebooks(source: unknown): LorebookProfile[] {
  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((item): item is LorebookProfile =>
    Boolean(item && typeof item === "object" && typeof item.id === "string"),
  );
}

function getQuickMessages(source: unknown): QuickMessage[] {
  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((item): item is QuickMessage =>
    Boolean(
      item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.content === "string" &&
      item.content.trim().length > 0,
    ),
  );
}

type ActiveTab = "quickmessages" | "mode" | "lorebook" | "skills";

const SETTINGS_TAB_BY_ACTIVE_TAB: Record<ActiveTab, string> = {
  quickmessages: "quick",
  mode: "mode",
  lorebook: "lorebook",
  skills: "skills",
};

interface SkillProfile {
  name: string;
  description?: string;
}

export function ExtensionPickerButtonImpl({ disabled = false, className }: ExtensionPickerButtonProps) {
  const { t } = useTranslation("input");
  const { settings, currentAssistant } = useCurrentAssistant();

  const [activeTab, setActiveTab] = React.useState<ActiveTab>("quickmessages");
  const [skills, setSkills] = React.useState<SkillProfile[]>([]);

  const canUse = Boolean(settings && currentAssistant && !disabled);
  const { error, setError, popoverProps } = usePickerPopover(canUse);

  const modeInjections = React.useMemo(
    () => getModeInjections(settings?.modeInjections),
    [settings?.modeInjections],
  );
  const lorebooks = React.useMemo(() => getLorebooks(settings?.lorebooks), [settings?.lorebooks]);
  const quickMessages = React.useMemo(
    () => getQuickMessages(settings?.quickMessages),
    [settings?.quickMessages],
  );
  const skillNameSet = React.useMemo(() => new Set(skills.map((item) => item.name)), [skills]);

  const modeInjectionIdSet = React.useMemo(
    () => new Set(modeInjections.map((item) => item.id)),
    [modeInjections],
  );
  const lorebookIdSet = React.useMemo(() => new Set(lorebooks.map((item) => item.id)), [lorebooks]);
  const quickMessageIdSet = React.useMemo(
    () => new Set(quickMessages.map((item) => item.id)),
    [quickMessages],
  );

  const selectedModeInjectionIds = React.useMemo(
    () => safeStringArray(currentAssistant?.modeInjectionIds),
    [currentAssistant?.modeInjectionIds],
  );
  const selectedLorebookIds = React.useMemo(
    () => safeStringArray(currentAssistant?.lorebookIds),
    [currentAssistant?.lorebookIds],
  );
  const selectedQuickMessageIds = React.useMemo(
    () => safeStringArray(currentAssistant?.quickMessageIds),
    [currentAssistant?.quickMessageIds],
  );
  const selectedSkillNames = React.useMemo(
    () => safeStringArray(currentAssistant?.enabledSkills),
    [currentAssistant?.enabledSkills],
  );

  const selectedCount =
    selectedModeInjectionIds.length +
    selectedLorebookIds.length +
    selectedQuickMessageIds.length +
    selectedSkillNames.length;
  const hasData =
    quickMessages.length > 0 ||
    modeInjections.length > 0 ||
    lorebooks.length > 0 ||
    skills.length > 0;

  React.useEffect(() => {
    if (!canUse) return;
    api
      .get<SkillProfile[]>("skills")
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [canUse]);

  React.useEffect(() => {
    if (!canUse || !hasData) {
      popoverProps.onOpenChange(false);
    }
  }, [canUse, hasData]);

  React.useEffect(() => {
    if (quickMessages.length > 0) {
      setActiveTab("quickmessages");
    } else if (modeInjections.length > 0) {
      setActiveTab("mode");
    } else if (lorebooks.length > 0) {
      setActiveTab("lorebook");
    } else if (skills.length > 0) {
      setActiveTab("skills");
    }
  }, [quickMessages.length, modeInjections.length, lorebooks.length, skills.length]);

  const updateExtensionsMutation = useMutation({
    mutationFn: ({
      assistantId,
      modeInjectionIds,
      lorebookIds,
      quickMessageIds,
    }: {
      assistantId: string;
      modeInjectionIds: string[];
      lorebookIds: string[];
      quickMessageIds: string[];
      key: string;
    }) =>
      api.post<{ status: string }>("settings/assistant/injections", {
        assistantId,
        modeInjectionIds,
        lorebookIds,
        quickMessageIds,
      }),
    onError: (updateError) => {
      setError(extractErrorMessage(updateError, t("injection.update_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const updateSkillsMutation = useMutation({
    mutationFn: ({
      assistantId,
      enabledSkills,
      key,
    }: {
      assistantId: string;
      enabledSkills: string[];
      key: string;
    }) => api.post<{ status: string }>("settings/assistant/skills", { assistantId, enabledSkills }),
    onError: (updateError) => {
      setError(extractErrorMessage(updateError, t("injection.update_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const buildPayload = (overrides: {
    modeInjectionIds?: string[];
    lorebookIds?: string[];
    quickMessageIds?: string[];
  }) => ({
    assistantId: currentAssistant!.id,
    modeInjectionIds:
      overrides.modeInjectionIds ??
      selectedModeInjectionIds.filter((id) => modeInjectionIdSet.has(id)),
    lorebookIds: overrides.lorebookIds ?? selectedLorebookIds.filter((id) => lorebookIdSet.has(id)),
    quickMessageIds:
      overrides.quickMessageIds ??
      selectedQuickMessageIds.filter((id) => quickMessageIdSet.has(id)),
  });

  const handleToggleModeInjection = React.useCallback(
    (id: string, checked: boolean) => {
      if (!canUse || !currentAssistant) return;
      const nextIds = new Set(
        selectedModeInjectionIds.filter((item) => modeInjectionIdSet.has(item)),
      );
      if (checked) nextIds.add(id);
      else nextIds.delete(id);
      updateExtensionsMutation.mutate({
        ...buildPayload({ modeInjectionIds: Array.from(nextIds) }),
        key: `mode:${id}`,
      });
    },
    [
      canUse,
      currentAssistant,
      modeInjectionIdSet,
      selectedModeInjectionIds,
      updateExtensionsMutation,
    ],
  );

  const handleToggleLorebook = React.useCallback(
    (id: string, checked: boolean) => {
      if (!canUse || !currentAssistant) return;
      const nextIds = new Set(selectedLorebookIds.filter((item) => lorebookIdSet.has(item)));
      if (checked) nextIds.add(id);
      else nextIds.delete(id);
      updateExtensionsMutation.mutate({
        ...buildPayload({ lorebookIds: Array.from(nextIds) }),
        key: `lorebook:${id}`,
      });
    },
    [canUse, currentAssistant, lorebookIdSet, selectedLorebookIds, updateExtensionsMutation],
  );

  const handleToggleQuickMessage = React.useCallback(
    (id: string, checked: boolean) => {
      if (!canUse || !currentAssistant) return;
      const nextIds = new Set(
        selectedQuickMessageIds.filter((item) => quickMessageIdSet.has(item)),
      );
      if (checked) nextIds.add(id);
      else nextIds.delete(id);
      updateExtensionsMutation.mutate({
        ...buildPayload({ quickMessageIds: Array.from(nextIds) }),
        key: `quickmessage:${id}`,
      });
    },
    [
      canUse,
      currentAssistant,
      quickMessageIdSet,
      selectedQuickMessageIds,
      updateExtensionsMutation,
    ],
  );

  const handleToggleSkill = React.useCallback(
    (name: string, checked: boolean) => {
      if (!canUse || !currentAssistant) return;
      const nextNames = new Set(selectedSkillNames.filter((item) => skillNameSet.has(item)));
      if (checked) nextNames.add(name);
      else nextNames.delete(name);
      updateSkillsMutation.mutate({
        assistantId: currentAssistant.id,
        enabledSkills: Array.from(nextNames),
        key: `skill:${name}`,
      });
    },
    [canUse, currentAssistant, selectedSkillNames, skillNameSet, updateSkillsMutation],
  );

  if (!hasData) {
    return null;
  }

  return (
    <Popover {...popoverProps}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canUse || updateExtensionsMutation.isPending || updateSkillsMutation.isPending}
          className={cn(
            "h-8 rounded-full px-2 text-muted-foreground hover:text-foreground",
            selectedCount > 0 && "text-primary hover:bg-primary/10",
            className,
          )}
        >
          {updateExtensionsMutation.isPending || updateSkillsMutation.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <PackageIcon className="size-4" />
          )}
          {selectedCount > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
              {selectedCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(92vw,26rem)] gap-0 p-0">
        <PopoverHeader className="border-b px-6 py-4">
          <PopoverTitle>{t("injection.title")}</PopoverTitle>
          <PopoverDescription>{t("injection.description")}</PopoverDescription>
        </PopoverHeader>

        <div className="space-y-4 px-4 py-4">
          <PickerErrorAlert error={error} />

          <div className="flex items-center gap-2">
            <div className="bg-muted inline-flex min-w-0 flex-1 rounded-full p-1">
              {quickMessages.length > 0 && (
                <button
                  type="button"
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition",
                    activeTab === "quickmessages"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                  onClick={() => {
                    setActiveTab("quickmessages");
                  }}
                >
                  {t("injection.tab_quickmessages")}
                </button>
              )}
              <button
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition",
                  activeTab === "mode"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground",
                )}
                onClick={() => {
                  setActiveTab("mode");
                }}
                disabled={modeInjections.length === 0}
              >
                {t("injection.tab_mode")}
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition",
                  activeTab === "lorebook"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground",
                )}
                onClick={() => {
                  setActiveTab("lorebook");
                }}
                disabled={lorebooks.length === 0}
              >
                {t("injection.tab_lorebook")}
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition",
                  activeTab === "skills"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground",
                )}
                onClick={() => {
                  setActiveTab("skills");
                }}
                disabled={skills.length === 0}
              >
                {t("injection.tab_skills", "Skills")}
              </button>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-xs">
              <a href={`/settings?section=mcp&tab=${SETTINGS_TAB_BY_ACTIVE_TAB[activeTab]}`}>
                <ExternalLink className="size-3.5" />
                {t("injection.manage", "管理")}
              </a>
            </Button>
          </div>

          <ScrollArea className="h-[16rem] pr-3">
            {activeTab === "quickmessages" ? (
              quickMessages.length > 0 ? (
                <div className="space-y-2">
                  {quickMessages.map((item) => {
                    const checked = selectedQuickMessageIds.includes(item.id);
                    const switching =
                      updateExtensionsMutation.isPending &&
                      updateExtensionsMutation.variables?.key === `quickmessage:${item.id}`;

                    return (
                      <label
                        key={item.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition",
                          checked && "border-primary bg-primary/5",
                        )}
                      >
                        {switching ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Checkbox
                            checked={checked}
                            disabled={disabled || updateExtensionsMutation.isPending}
                            onCheckedChange={(nextChecked) => {
                              handleToggleQuickMessage(item.id, Boolean(nextChecked));
                            }}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {getDisplayName(item.title, t("injection.unnamed_quickmessage"))}
                          </div>
                          <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                            {item.content}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("injection.empty_quickmessages")}
                </div>
              )
            ) : activeTab === "mode" ? (
              modeInjections.length > 0 ? (
                <div className="space-y-2">
                  {modeInjections.map((item) => {
                    const checked = selectedModeInjectionIds.includes(item.id);
                    const switching =
                      updateExtensionsMutation.isPending &&
                      updateExtensionsMutation.variables?.key === `mode:${item.id}`;

                    return (
                      <label
                        key={item.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition",
                          checked && "border-primary bg-primary/5",
                        )}
                      >
                        {switching ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Checkbox
                            checked={checked}
                            disabled={disabled || updateExtensionsMutation.isPending}
                            onCheckedChange={(nextChecked) => {
                              handleToggleModeInjection(item.id, Boolean(nextChecked));
                            }}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {getDisplayName(item.name, t("injection.unnamed_mode"))}
                          </div>
                          {item.enabled === false ? (
                            <div className="text-muted-foreground mt-0.5 text-xs">
                              {t("injection.disabled")}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("injection.empty_mode")}
                </div>
              )
            ) : activeTab === "lorebook" ? (
              lorebooks.length > 0 ? (
                <div className="space-y-2">
                  {lorebooks.map((item) => {
                    const checked = selectedLorebookIds.includes(item.id);
                    const switching =
                      updateExtensionsMutation.isPending &&
                      updateExtensionsMutation.variables?.key === `lorebook:${item.id}`;

                    return (
                      <label
                        key={item.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition",
                          checked && "border-primary bg-primary/5",
                        )}
                      >
                        {switching ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Checkbox
                            checked={checked}
                            disabled={disabled || updateExtensionsMutation.isPending}
                            onCheckedChange={(nextChecked) => {
                              handleToggleLorebook(item.id, Boolean(nextChecked));
                            }}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {getDisplayName(item.name, t("injection.unnamed_lorebook"))}
                          </div>
                          {typeof item.description === "string" &&
                          item.description.trim().length > 0 ? (
                            <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                              {item.description}
                            </div>
                          ) : null}
                          {item.enabled === false ? (
                            <div className="text-muted-foreground mt-0.5 text-xs">
                              {t("injection.disabled")}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("injection.empty_lorebook")}
                </div>
              )
            ) : skills.length > 0 ? (
              <div className="space-y-2">
                {skills.map((item) => {
                  const checked = selectedSkillNames.includes(item.name);
                  const switching =
                    updateSkillsMutation.isPending &&
                    updateSkillsMutation.variables?.key === `skill:${item.name}`;

                  return (
                    <label
                      key={item.name}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition",
                        checked && "border-primary bg-primary/5",
                      )}
                    >
                      {switching ? (
                        <LoaderCircle className="mt-0.5 size-4 animate-spin" />
                      ) : (
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={disabled || updateSkillsMutation.isPending}
                          onCheckedChange={(nextChecked) => {
                            handleToggleSkill(item.name, Boolean(nextChecked));
                          }}
                        />
                      )}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{item.name}</div>
                        {item.description ? (
                          <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                            {item.description}
                          </div>
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                {t("injection.empty_skills", "No Skills")}
              </div>
            )}
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// memo:disabled/className 在打字时不变,跳过重渲染。
export const ExtensionPickerButton = React.memo(ExtensionPickerButtonImpl);
