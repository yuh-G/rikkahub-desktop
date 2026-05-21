// Open an external URL — uses Tauri's shell plugin when running inside the desktop shell
// (which routes through the OS default browser), and falls back to `window.open` for the
// dev browser. Centralized so a single global click handler in root.tsx can intercept every
// `<a target="_blank">` click in the app without each component having to know about Tauri.

let cachedOpen: ((url: string) => Promise<void>) | null | undefined;

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadTauriOpen(): Promise<((url: string) => Promise<void>) | null> {
  if (cachedOpen !== undefined) return cachedOpen;
  if (!isTauriEnvironment()) {
    cachedOpen = null;
    return null;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    cachedOpen = open;
    return open;
  } catch (err) {
    console.warn("[external-link] failed to load Tauri shell plugin", err);
    cachedOpen = null;
    return null;
  }
}

export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  const tauriOpen = await loadTauriOpen();
  if (tauriOpen) {
    try {
      await tauriOpen(url);
      return;
    } catch (err) {
      console.warn("[external-link] Tauri shell.open failed, falling back to window.open", err);
    }
  }
  // Plain browser dev mode, or Tauri shell unavailable for some reason.
  window.open(url, "_blank", "noopener,noreferrer");
}
