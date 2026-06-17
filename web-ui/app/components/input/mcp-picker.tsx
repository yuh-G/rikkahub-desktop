import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LoaderCircle, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { usePickerPopover } from "~/hooks/use-picker-popover";
import { getDisplayName } from "~/lib/display";
import { extractErrorMessage } from "~/lib/error";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { safeStringArray } from "~/lib/type-guards";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { McpServerConfig, McpToolOption, McpToolOverride } from "~/types";
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

export interface McpPickerButtonProps {
  disabled?: boolean;
  className?: string;
}

function getEnabledToolsCount(tools: McpToolOption[] | undefined): {
  enabled: number;
  total: number;
} {
  if (!tools || tools.length === 0) {
    return { enabled: 0, total: 0 };
  }

  const total = tools.length;
  const enabled = tools.filter((tool) => tool.enable).length;
  return { enabled, total };
}

export function McpPickerButtonImpl({ disabled = false, className }: McpPickerButtonProps) {
  const { t } = useTranslation("input");
  const { settings, currentAssistant } = useCurrentAssistant();

  const canUse = Boolean(settings && currentAssistant && !disabled);
  const { error, setError, popoverProps } = usePickerPopover(canUse);

  const allServers = settings?.mcpServers ?? [];
  const knownServerIdSet = React.useMemo(
    () => new Set(allServers.map((server) => server.id)),
    [allServers],
  );
  const enabledServers = React.useMemo(
    () => allServers.filter((server) => server.commonOptions?.enable),
    [allServers],
  );
  const enabledServerIdSet = React.useMemo(
    () => new Set(enabledServers.map((server) => server.id)),
    [enabledServers],
  );

  const selectedServerIds = React.useMemo(
    () => safeStringArray(currentAssistant?.mcpServers),
    [currentAssistant?.mcpServers],
  );

  const selectedServerIdSet = React.useMemo(() => new Set(selectedServerIds), [selectedServerIds]);
  const selectedEnabledCount = React.useMemo(
    () => selectedServerIds.filter((serverId) => enabledServerIdSet.has(serverId)).length,
    [enabledServerIdSet, selectedServerIds],
  );

  React.useEffect(() => {
    if (!canUse) {
      popoverProps.onOpenChange(false);
    }
  }, [canUse]);

  const updateMcpMutation = useMutation({
    mutationFn: ({
      nextServerIds,
      assistantId,
    }: {
      nextServerIds: string[];
      assistantId: string;
      serverId: string;
    }) =>
      api.post<{ status: string }>("settings/assistant/mcp", {
        assistantId,
        mcpServerIds: nextServerIds,
      }),
    onError: (updateError) => {
      setError(extractErrorMessage(updateError, t("mcp.update_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const handleToggleServer = React.useCallback(
    (serverId: string, enabled: boolean) => {
      if (!canUse || !currentAssistant) {
        return;
      }

      const nextServerIds = new Set(
        selectedServerIds.filter((selectedServerId) => knownServerIdSet.has(selectedServerId)),
      );

      if (enabled) {
        nextServerIds.add(serverId);
      } else {
        nextServerIds.delete(serverId);
      }

      updateMcpMutation.mutate({
        nextServerIds: Array.from(nextServerIds),
        assistantId: currentAssistant.id,
        serverId,
      });
    },
    [canUse, currentAssistant, knownServerIdSet, selectedServerIds, updateMcpMutation],
  );

  // Per-tool override mutation. The backend persists `null` as "clear override (revert to
  // global default)" — the React Query mutation just forwards the body as-is.
  const updateToolOverrideMutation = useMutation({
    mutationFn: (payload: {
      assistantId: string;
      serverId: string;
      toolName: string;
      enable?: boolean | null;
      needsApproval?: boolean | null;
    }) => api.post<{ status: string }>("settings/assistant/mcp-tool-override", payload),
    onError: (overrideError) => {
      setError(extractErrorMessage(overrideError, t("mcp.update_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  // Per-server expand/collapse state. Default collapsed. Tracking by server id since servers
  // get reordered/removed independent of the user's expand state.
  const [expandedServerIds, setExpandedServerIds] = React.useState<Set<string>>(new Set());
  const toggleExpand = (serverId: string) => {
    setExpandedServerIds((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  // Read current assistant's override for one (server, tool). Returns the override entry or
  // an empty object so callers can do `override.enable ?? true` style fallbacks.
  const getOverride = (serverId: string, toolName: string): McpToolOverride => {
    const overrides = currentAssistant?.mcpToolOverrides as
      | Record<string, Record<string, McpToolOverride>>
      | undefined;
    return overrides?.[serverId]?.[toolName] ?? {};
  };

  return (
    <Popover {...popoverProps}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canUse || updateMcpMutation.isPending}
          className={cn(
            "h-8 rounded-full px-2 text-muted-foreground hover:text-foreground",
            selectedEnabledCount > 0 && "text-primary hover:bg-primary/10",
            className,
          )}
        >
          {updateMcpMutation.isPending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Terminal className="size-3.5" />
          )}
          {selectedEnabledCount > 0 ? (
            <span className="rounded-full bg-primary/10 px-1 py-0.5 text-[9px] text-primary">
              {selectedEnabledCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(92vw,22rem)] gap-0 p-0">
        <PopoverHeader className="border-b px-3 py-2.5">
          <PopoverTitle className="text-sm">{t("mcp.title")}</PopoverTitle>
          <PopoverDescription className="text-[11px]">{t("mcp.description")}</PopoverDescription>
        </PopoverHeader>

        <div className="space-y-2 px-2.5 py-2.5">
          <PickerErrorAlert error={error} />

          <ScrollArea className="h-[32vh] pr-1.5">
            {enabledServers.length > 0 ? (
              <div className="space-y-1">
                {enabledServers.map((server) => {
                  const selected = selectedServerIdSet.has(server.id);
                  const switching =
                    updateMcpMutation.isPending &&
                    updateMcpMutation.variables?.serverId === server.id;
                  const toolCount = getEnabledToolsCount(server.commonOptions?.tools);
                  const expanded = expandedServerIds.has(server.id);
                  // Only globally-enabled tools surface here. A tool with global enable=false
                  // is invisible to the user in this picker — matching the rule "设置中关闭的
                  // 工具会话里看不见". The per-assistant override only refines among the
                  // globally-enabled set.
                  const visibleTools: McpToolOption[] = (server.commonOptions?.tools ?? []).filter(
                    (tool) => tool.enable !== false,
                  );

                  return (
                    <div
                      key={server.id}
                      className={cn(
                        "rounded-md border transition",
                        selected && "border-primary bg-primary/5",
                      )}
                    >
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => toggleExpand(server.id)}
                          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
                          aria-label={expanded ? "收起" : "展开"}
                          disabled={visibleTools.length === 0}
                          title={
                            visibleTools.length === 0
                              ? "暂无可用工具"
                              : expanded
                                ? "收起工具列表"
                                : "展开工具列表"
                          }
                        >
                          {switching ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : expanded ? (
                            <ChevronDown className="size-3" />
                          ) : (
                            <ChevronRight className="size-3" />
                          )}
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-medium leading-tight">
                            {getDisplayName(server.commonOptions?.name, t("mcp.unnamed_server"))}
                          </div>
                          <div className="text-muted-foreground text-[10px] leading-tight">
                            {t("mcp.tools_enabled", {
                              enabled: toolCount.enabled,
                              total: toolCount.total,
                            })}
                          </div>
                        </div>

                        <Switch
                          size="sm"
                          checked={selected}
                          disabled={disabled || updateMcpMutation.isPending}
                          onCheckedChange={(nextChecked) => {
                            handleToggleServer(server.id, nextChecked);
                          }}
                        />
                      </div>

                      {expanded && visibleTools.length > 0 ? (
                        // Per-tool override panel. The rule for each tool's `enable` state:
                        //   global=true & no override          → checked (default behavior)
                        //   global=true & override.enable=false → unchecked (assistant disabled)
                        //   global=true & override.enable=true  → checked (explicit, same as default)
                        // We send `null` to the backend to clear an override (restore default).
                        //
                        // Master/child semantics: when the assistant has the MCP server master
                        // OFF (`!selected`), the per-tool switches stay visible AND show their
                        // last preference, but are read-only & greyed — toggling the server
                        // back on will revive whatever the user had configured.
                        <div
                          className={cn(
                            "border-t bg-muted/30 px-2 py-1.5 space-y-1",
                            !selected && "opacity-60",
                          )}
                        >
                          {visibleTools.map((tool) => {
                            const override = getOverride(server.id, tool.name);
                            const effectiveEnabled = override.enable !== false;
                            const effectiveNeedsApproval =
                              typeof override.needsApproval === "boolean"
                                ? override.needsApproval
                                : tool.needsApproval === true;
                            const isMutating =
                              updateToolOverrideMutation.isPending &&
                              updateToolOverrideMutation.variables?.serverId === server.id &&
                              updateToolOverrideMutation.variables?.toolName === tool.name;
                            return (
                              <div
                                key={tool.name}
                                className="flex items-center gap-1.5 rounded px-1 py-1"
                              >
                                <div className="min-w-0 flex-1">
                                  <div
                                    className="truncate text-[11px] leading-tight"
                                    title={tool.name}
                                  >
                                    {tool.name}
                                  </div>
                                </div>
                                {isMutating ? (
                                  <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
                                ) : null}
                                <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <span>需要用户审核</span>
                                  <Switch
                                    size="sm"
                                    checked={effectiveNeedsApproval}
                                    disabled={disabled || !currentAssistant || !selected}
                                    onCheckedChange={(nextChecked) => {
                                      if (!currentAssistant) return;
                                      // If the toggle matches the global default, clear the
                                      // override (send null) to keep state minimal. Otherwise
                                      // store the explicit override.
                                      const matchesGlobal =
                                        nextChecked === (tool.needsApproval === true);
                                      updateToolOverrideMutation.mutate({
                                        assistantId: currentAssistant.id,
                                        serverId: server.id,
                                        toolName: tool.name,
                                        needsApproval: matchesGlobal ? null : nextChecked,
                                      });
                                    }}
                                  />
                                </label>
                                <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <span>启用</span>
                                  <Switch
                                    size="sm"
                                    checked={effectiveEnabled}
                                    disabled={disabled || !currentAssistant || !selected}
                                    onCheckedChange={(nextChecked) => {
                                      if (!currentAssistant) return;
                                      // enable=true is the global default → clear the override.
                                      // enable=false → explicit override to disable for this assistant.
                                      updateToolOverrideMutation.mutate({
                                        assistantId: currentAssistant.id,
                                        serverId: server.id,
                                        toolName: tool.name,
                                        enable: nextChecked ? null : false,
                                      });
                                    }}
                                  />
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                {t("mcp.empty")}
              </div>
            )}
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// memo:disabled/className 在打字时不变,跳过重渲染。
export const McpPickerButton = React.memo(McpPickerButtonImpl);
