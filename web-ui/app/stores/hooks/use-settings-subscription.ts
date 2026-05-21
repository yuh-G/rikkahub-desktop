import { useEffect, useRef } from "react";

import api, { sse } from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { Settings } from "~/types";

/**
 * Hook to subscribe to settings SSE stream (call once in root)
 */
export function useSettingsSubscription() {
  const setSettings = useSettingsStore((state) => state.setSettings);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortControllerRef.current = new AbortController();
    let closed = false;

    const refreshSettings = () => {
      api.get<Settings>("settings").then((settings) => {
        if (!closed) setSettings(settings);
      }).catch((error) => {
        console.error("Settings refresh error:", error);
      });
    };

    refreshSettings();

    sse<Settings>(
      "settings/stream",
      {
        onMessage: ({ data }) => {
          setSettings(data);
        },
        onError: (error) => {
          console.error("Settings SSE error:", error);
          refreshSettings();
        },
      },
      { signal: abortControllerRef.current.signal },
    );

    return () => {
      closed = true;
      abortControllerRef.current?.abort();
    };
  }, [setSettings]);
}
