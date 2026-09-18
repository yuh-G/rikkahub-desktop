// MCP 连接健康 store(7.2):订阅 /api/events 通道的 mcp_health 快照,供设置页状态灯渲染,
// 并按决策②收敛通知——仅"授权过期/持续失败(只有用户能救)"弹一次 toast,网络瞬态自动
// 修复完全不打扰。
// 契约:快照事件通道内重放,直接整表替换(无增量合并);健康是内存态,重启即干净 idle。
import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "sonner";

import { onAppEvent } from "~/services/app-events";
import i18n from "~/i18n";
import type { McpHealthEntryDto, McpHealthSnapshotDto } from "~/types";

interface McpHealthStoreState {
  /** serverId → 健康项。只含"被启用且被某助手选中"的服务器(决策①)。 */
  health: McpHealthSnapshotDto;
  setHealth: (snapshot: McpHealthSnapshotDto) => void;
}

export const useMcpHealthStore = create<McpHealthStoreState>((set) => ({
  health: {},
  setHealth: (health) => set({ health }),
}));

/** 某台服务器的健康项(设置页状态灯用)。 */
export function useMcpServerHealth(serverId: string): McpHealthEntryDto | undefined {
  return useMcpHealthStore((s) => s.health[serverId]);
}

/** 决策②:同一 server 的同一类故障只通知一次(恢复后再次故障才重新通知)。 */
const notifiedFailures = new Set<string>();

function notifyIfActionable(serverId: string, entry: McpHealthEntryDto): void {
  if (entry.status !== "failed") {
    // 恢复(ready/reconnecting)即清除已通知标记,允许下次故障再报。
    notifiedFailures.delete(serverId);
    return;
  }
  // 只有"用户能救"的故障才主动打扰:授权过期、配置错误、持续不可用。
  // 纯网络瞬态(network_transient)会被后台重连自愈,不通知(决策②收敛)。
  const actionable = entry.kind === "auth_expired" || entry.kind === "config_error" || entry.kind === "server_unavailable";
  if (!actionable) return;
  const key = `${serverId}:${entry.kind}`;
  if (notifiedFailures.has(key)) return;
  notifiedFailures.add(key);
  toast.error(i18n.t(`settings:mcp.health_notify.${entry.kind}`, { defaultValue: entry.message }), {
    duration: 8000,
  });
}

/** 订阅 mcp_health 事件(根组件调用一次)。走单一 /api/events 通道(连接预算纪律)。 */
export function useMcpHealthSubscription(): void {
  const setHealth = useMcpHealthStore((s) => s.setHealth);
  useEffect(() => {
    return onAppEvent("mcp_health", (snapshot) => {
      const prev = useMcpHealthStore.getState().health;
      setHealth(snapshot);
      // 状态翻转驱动收敛通知(只在进入 failed 且 actionable 时)。
      for (const [serverId, entry] of Object.entries(snapshot)) {
        const prevEntry = prev[serverId];
        // 仅在状态变为 failed 或 failed 的 kind 变化时评估,避免同帧重复。
        if (entry.status === "failed" && prevEntry?.status === "failed" && prevEntry.kind === entry.kind) continue;
        notifyIfActionable(serverId, entry);
      }
      // 从快照中消失的服务器(禁用/取消选中/删除)清掉其通知标记。
      for (const serverId of Object.keys(prev)) {
        if (!(serverId in snapshot)) notifiedFailures.delete(serverId);
      }
    });
  }, [setHealth]);
}
