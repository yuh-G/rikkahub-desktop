import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, PackageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { useShallow } from "zustand/react/shallow";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { usePickerPopover } from "~/hooks/use-picker-popover";
import { getDisplayName } from "~/lib/display";
import { extractErrorMessage } from "~/lib/error";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { safeStringArray } from "~/lib/type-guards";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useConversationStore } from "~/stores/conversation-store";
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
import { SettingsLink } from "~/components/settings/settings-link";

import { McpPanel, useMcpBadge } from "./mcp-picker";
import { PickerErrorAlert } from "./picker-error-alert";

// 拓展选择器(前端重构A2,用户拍板"MCP和拓展入口合一"):MCP 以第一个标签页并入,
// 本组件成为输入行上 MCP+拓展 的唯一入口;徽标计数 = 拓展选中数 + MCP 选中数。

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

type ActiveTab = "mcp" | "quickmessages" | "mode" | "lorebook" | "skills";

// 「管理」深链:选择器的 tab → 设置里的二级页(模式注入与世界书同在提示词注入页,tab 选板块)。
const SETTINGS_LINK_BY_ACTIVE_TAB: Record<ActiveTab, string> = {
  mcp: "?section=extensions&sub=mcp",
  quickmessages: "?section=extensions&sub=quick",
  mode: "?section=extensions&sub=injection&tab=mode",
  lorebook: "?section=extensions&sub=injection&tab=lorebook",
  skills: "?section=extensions&sub=skills",
};

interface SkillProfile {
  name: string;
  description?: string;
}

export function ExtensionPickerButtonImpl({ disabled = false, className }: ExtensionPickerButtonProps) {
  const { t } = useTranslation("input");
  const { settings, currentAssistant } = useCurrentAssistant();

  // 专题9：独立对话提示词注入（对齐安卓 ExtensionSelector）——助手开启
  // allowConversationPromptInjection 且当前在某个会话里时，注入/世界书的勾选读写
  // 会话上的同名字段；快捷消息与 Skills 始终是助手级。
  const { id: routeConversationId } = useParams();
  // D1(专题9复查):窄订阅——本组件只消费"会话是否存在 + 两个 id 集"三个标量。
  // 订阅整个 entry 会让常驻输入区在流式期间随每帧 text_delta 重渲染(entry 每帧重建),
  // 违反 D 族“流式帧只重渲染正在生成的节点”的纪律。id 集经 useShallow 浅比较,
  // 内容不变时保持引用稳定,变化时才触发重渲染。
  const conversationId = routeConversationId ?? null;
  const conversationExists = useConversationStore((s) =>
    Boolean(conversationId && s.entries[conversationId]?.detail),
  );
  const conversationModeIds = useConversationStore(
    useShallow((s) =>
      conversationId ? safeStringArray(s.entries[conversationId]?.detail?.modeInjectionIds) : [],
    ),
  );
  const conversationLorebookIds = useConversationStore(
    useShallow((s) =>
      conversationId ? safeStringArray(s.entries[conversationId]?.detail?.lorebookIds) : [],
    ),
  );
  const useConversationInjections =
    currentAssistant?.allowConversationPromptInjection === true && conversationExists;

  const mcpBadge = useMcpBadge();
  const [activeTab, setActiveTab] = React.useState<ActiveTab>(
    mcpBadge.hasServers ? "mcp" : "quickmessages",
  );
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
    () =>
      useConversationInjections
        ? conversationModeIds
        : safeStringArray(currentAssistant?.modeInjectionIds),
    [useConversationInjections, conversationModeIds, currentAssistant?.modeInjectionIds],
  );
  const selectedLorebookIds = React.useMemo(
    () =>
      useConversationInjections
        ? conversationLorebookIds
        : safeStringArray(currentAssistant?.lorebookIds),
    [useConversationInjections, conversationLorebookIds, currentAssistant?.lorebookIds],
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
    selectedSkillNames.length +
    mcpBadge.count;
  const hasData =
    mcpBadge.hasServers ||
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
    if (mcpBadge.hasServers) {
      setActiveTab("mcp");
    } else if (quickMessages.length > 0) {
      setActiveTab("quickmessages");
    } else if (modeInjections.length > 0) {
      setActiveTab("mode");
    } else if (lorebooks.length > 0) {
      setActiveTab("lorebook");
    } else if (skills.length > 0) {
      setActiveTab("skills");
    }
  }, [
    mcpBadge.hasServers,
    quickMessages.length,
    modeInjections.length,
    lorebooks.length,
    skills.length,
  ]);

  // 助手级写入。端点为部分更新语义:只覆盖提交的数组,省略字段不动——
  // 调用方只发自己改的那一个集,无需回填其余现值(回填取错作用域曾导致交叉污染)。
  const updateExtensionsMutation = useMutation({
    mutationFn: ({
      assistantId,
      modeInjectionIds,
      lorebookIds,
      quickMessageIds,
    }: {
      assistantId: string;
      modeInjectionIds?: string[];
      lorebookIds?: string[];
      quickMessageIds?: string[];
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

  // 会话级写入：成功后不刷 settings（数据在会话上），后端会广播快照更新 store。
  const updateConversationInjectionsMutation = useMutation({
    mutationFn: ({
      conversationId,
      modeInjectionIds,
      lorebookIds,
    }: {
      conversationId: string;
      modeInjectionIds?: string[];
      lorebookIds?: string[];
      key: string;
    }) =>
      api.post<{ status: string }>(`conversations/${conversationId}/injections`, {
        modeInjectionIds,
        lorebookIds,
      }),
    onError: (updateError) => {
      setError(extractErrorMessage(updateError, t("injection.update_failed")));
    },
    onSuccess: () => {
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

  // 注入/世界书/快捷消息的写入可能走助手级或会话级两条 mutation，合并展示态。
  const extensionsPending =
    updateExtensionsMutation.isPending || updateConversationInjectionsMutation.isPending;
  const pendingExtensionKey = updateExtensionsMutation.isPending
    ? updateExtensionsMutation.variables?.key
    : updateConversationInjectionsMutation.isPending
      ? updateConversationInjectionsMutation.variables?.key
      : undefined;

  const handleToggleModeInjection = React.useCallback(
    (id: string, checked: boolean) => {
      if (!canUse || !currentAssistant) return;
      const nextIds = new Set(
        selectedModeInjectionIds.filter((item) => modeInjectionIdSet.has(item)),
      );
      if (checked) nextIds.add(id);
      else nextIds.delete(id);
      if (useConversationInjections) {
        updateConversationInjectionsMutation.mutate({
          conversationId: conversationId!,
          modeInjectionIds: Array.from(nextIds),
          key: `mode:${id}`,
        });
        return;
      }
      updateExtensionsMutation.mutate({
        assistantId: currentAssistant.id,
        modeInjectionIds: Array.from(nextIds),
        key: `mode:${id}`,
      });
    },
    [
      canUse,
      currentAssistant,
      conversationId,
      useConversationInjections,
      modeInjectionIdSet,
      selectedModeInjectionIds,
      updateConversationInjectionsMutation,
      updateExtensionsMutation,
    ],
  );

  const handleToggleLorebook = React.useCallback(
    (id: string, checked: boolean) => {
      if (!canUse || !currentAssistant) return;
      const nextIds = new Set(selectedLorebookIds.filter((item) => lorebookIdSet.has(item)));
      if (checked) nextIds.add(id);
      else nextIds.delete(id);
      if (useConversationInjections) {
        updateConversationInjectionsMutation.mutate({
          conversationId: conversationId!,
          lorebookIds: Array.from(nextIds),
          key: `lorebook:${id}`,
        });
        return;
      }
      updateExtensionsMutation.mutate({
        assistantId: currentAssistant.id,
        lorebookIds: Array.from(nextIds),
        key: `lorebook:${id}`,
      });
    },
    [
      canUse,
      currentAssistant,
      conversationId,
      useConversationInjections,
      lorebookIdSet,
      selectedLorebookIds,
      updateConversationInjectionsMutation,
      updateExtensionsMutation,
    ],
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
        assistantId: currentAssistant.id,
        quickMessageIds: Array.from(nextIds),
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
          disabled={!canUse || extensionsPending || updateSkillsMutation.isPending}
          className={cn(
            "h-8 rounded-full px-2 text-muted-foreground hover:text-foreground",
            selectedCount > 0 && "text-primary hover:bg-primary/10",
            className,
          )}
        >
          {extensionsPending || updateSkillsMutation.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <PackageIcon className="size-4" />
          )}
          {selectedCount > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-micro text-primary">
              {selectedCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(92vw,26rem)] gap-0 p-0">
        <PopoverHeader className="border-b px-6 py-4">
          <PopoverTitle>{t("integrations.title")}</PopoverTitle>
          <PopoverDescription>{t("integrations.description")}</PopoverDescription>
        </PopoverHeader>

        <div className="space-y-4 px-4 py-4">
          <PickerErrorAlert error={error} />

          <div className="flex items-center gap-2">
            <div className="bg-muted inline-flex min-w-0 flex-1 rounded-full p-1">
              {mcpBadge.hasServers && (
                <button
                  type="button"
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition",
                    activeTab === "mcp"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                  onClick={() => {
                    setActiveTab("mcp");
                  }}
                >
                  {t("integrations.tab_mcp")}
                </button>
              )}
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
                {t("injection.tab_skills")}
              </button>
            </div>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-xs">
              <SettingsLink
                search={SETTINGS_LINK_BY_ACTIVE_TAB[activeTab]}
                onClick={() => popoverProps.onOpenChange(false)}
              >
                <ExternalLink className="size-3.5" />
                {t("injection.manage")}
              </SettingsLink>
            </Button>
          </div>

          {activeTab === "mcp" ? (
            <McpPanel disabled={disabled} />
          ) : (
          <ScrollArea className="h-[16rem] pr-3">
            {activeTab === "quickmessages" ? (
              quickMessages.length > 0 ? (
                <div className="space-y-2">
                  {quickMessages.map((item) => {
                    const checked = selectedQuickMessageIds.includes(item.id);
                    const switching =
                      extensionsPending && pendingExtensionKey === `quickmessage:${item.id}`;

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
                            disabled={disabled || extensionsPending}
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
                    const switching = extensionsPending && pendingExtensionKey === `mode:${item.id}`;

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
                            disabled={disabled || extensionsPending}
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
                      extensionsPending && pendingExtensionKey === `lorebook:${item.id}`;

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
                            disabled={disabled || extensionsPending}
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
                {t("injection.empty_skills")}
              </div>
            )}
          </ScrollArea>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// memo:disabled/className 在打字时不变,跳过重渲染。
export const ExtensionPickerButton = React.memo(ExtensionPickerButtonImpl);
