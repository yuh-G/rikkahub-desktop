import { useEffect, useRef } from "react";
import { create } from "zustand";

import { sse } from "~/services/api";
import type { MemorySnapshot } from "~/types";

interface MemoryStoreState {
  snapshot: MemorySnapshot | null;
  setSnapshot: (snapshot: MemorySnapshot | null) => void;
}

/** 记忆运行时 store:持有 memory SSE 推送的完整快照。设置「记忆」板块 + 会话页徽章都从此读。 */
export const useMemoryStore = create<MemoryStoreState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));

/** 订阅 memory SSE(/api/memory/stream)。根组件调用一次。后端连接后立即推完整 snapshot,
 *  之后任何记忆/pending 变化都触发推送。独立于 settings SSE——记忆运行时数据不属于配置(§10.3)。
 *
 *  重连:sse() 本身不自动重连(I1 健壮性)。这里在 onClose 时按指数退避(1s/2s/4s…封顶 30s)
 *  重新订阅,避免网络抖动/后端重启后 memory snapshot 停更、徽章数字与实际状态对不上。
 *  收到任何消息即认定连接健康、重置退避计数。组件卸载时 closed=true,不再重连。 */
export function useMemorySubscription() {
  const setSnapshot = useMemoryStore((s) => s.setSnapshot);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    let closed = false;

    const connect = () => {
      if (closed) return;
      abortRef.current = new AbortController();
      void sse<MemorySnapshot>(
        "memory/stream",
        {
          onMessage: ({ data }) => {
            if (!closed) {
              setSnapshot(data);
              attemptRef.current = 0;
            }
          },
          onError: (error) => {
            console.error("Memory SSE error:", error);
          },
          onClose: () => {
            if (closed) return;
            const delay = Math.min(1000 * 2 ** attemptRef.current, 30000);
            attemptRef.current += 1;
            reconnectTimer.current = setTimeout(connect, delay);
          },
        },
        { signal: abortRef.current.signal },
      );
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      abortRef.current?.abort();
    };
  }, [setSnapshot]);
}
