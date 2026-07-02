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
 *  之后任何记忆/pending 变化都触发推送。独立于 settings SSE——记忆运行时数据不属于配置(§10.3)。 */
export function useMemorySubscription() {
  const setSnapshot = useMemoryStore((s) => s.setSnapshot);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current = new AbortController();
    let closed = false;
    sse<MemorySnapshot>(
      "memory/stream",
      {
        onMessage: ({ data }) => {
          if (!closed) setSnapshot(data);
        },
        onError: (error) => {
          console.error("Memory SSE error:", error);
        },
      },
      { signal: abortRef.current.signal },
    );
    return () => {
      closed = true;
      abortRef.current?.abort();
    };
  }, [setSnapshot]);
}
