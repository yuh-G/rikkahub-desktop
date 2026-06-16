import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from "react-router";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Route } from "./+types/root";
import { useSettingsStore, useSettingsSubscription } from "~/stores";
import "./app.css";
import "./i18n";
import { Toaster } from "./components/ui/sonner";
import { ThemeProvider } from "./components/theme-provider";
import { TitleBar } from "./components/title-bar";
import { UpdateDialog, type UpdateInfo } from "./components/update-dialog";
import { WebAuthGate } from "./components/web-auth-gate";
import { FontFaceInjector } from "./components/font-face-injector";
import { openExternal } from "./lib/external-link";
import api from "~/services/api";

const queryClient = new QueryClient();

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", type: "image/x-icon", sizes: "any" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// Silent startup update check: queries GitHub once, shows the full download/install dialog
// only when a newer version exists. Errors and "already latest" are swallowed completely.
function SilentUpdateChecker() {
  const [update, setUpdate] = React.useState<UpdateInfo | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<UpdateInfo>("update/check")
      .then((info) => {
        if (!cancelled && info.isNewer && !info.isSkipped) setUpdate(info);
      })
      .catch(() => {
        /* network error — silently ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;
  return <UpdateDialog info={update} open={true} onClose={() => setUpdate(null)} />;
}

// 把中文字体插入英文字体 family 链:插在主字体之后、其余 fallback 之前。
// '"HarmonyOS Sans", system-ui, sans-serif' + '"思源宋体", serif'
//   → '"HarmonyOS Sans", "思源宋体", serif, system-ui, sans-serif'
// 思路:英文字体通常只有一个主字体(在链首),其余是 generic 兜底。把中文字体族插在
// 链首之后,既保证英文字形优先用英文字体,又让中文字形在落到 generic 兜底前先尝试中文字体。
// 中文字体族自带的 fallback(如 "思源宋体", serif)原样保留在中间。
// 没设中文字体(cjk 空)→ 返回原始 family,行为同前。
function mergeCjkIntoFamily(enFamily: string, cjkFamily: string): string {
  if (!cjkFamily.trim()) return enFamily.trim();
  const en = enFamily.trim();
  if (!en) return cjkFamily.trim();
  const idx = en.indexOf(",");
  return idx < 0 ? `${en}, ${cjkFamily}` : `${en.slice(0, idx)}, ${cjkFamily}${en.slice(idx)}`;
}

// 仅在不同顶层页面之间播放过渡动画；在同一大页内切换（如 /c/123 -> /c/456）
// 保持连续，避免聊天界面闪烁。
function getTopLevelPageKey(pathname: string): string {
  if (pathname === "/" || pathname.startsWith("/c/")) return "chat";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/images")) return "images";
  return pathname;
}

function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const pageKey = getTopLevelPageKey(location.pathname);

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pageKey}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="contents"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

function AppContent() {
  useSettingsSubscription();
  const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    // 中英文分别设置(Word 式):把中文字体插到英文字体 family 链的"主字体之后、兜底之前"。
    // 效果:英文字形用英文字体,中文字形英文字体没有 → 落到中文字体,再落到兜底。
    // 没设中文字体时 cjkInsert 为空,拼接退化为纯英文链,行为同前(向后兼容)。
    const uiEn = String(
      displaySetting?.uiFontFamilyCss ?? displaySetting?.uiFontFamily ?? "",
    ).trim();
    const chatEn = String(
      displaySetting?.chatFontFamilyCss ?? displaySetting?.chatFontFamily ?? "",
    ).trim();
    const uiCjk = String(displaySetting?.uiFontFamilyCjkCss ?? "").trim();
    const chatCjk = String(displaySetting?.chatFontFamilyCjkCss ?? "").trim();
    const uiFont =
      mergeCjkIntoFamily(uiEn, uiCjk) || '"Noto Sans SC", "Microsoft YaHei", var(--font-sans)';
    const chatFont = mergeCjkIntoFamily(chatEn, chatCjk) || "inherit";
    document.body.style.setProperty("--rikkahub-ui-font", uiFont);
    document.body.style.setProperty("--rikkahub-chat-font", chatFont);
  }, [
    displaySetting?.chatFontFamily,
    displaySetting?.chatFontFamilyCss,
    displaySetting?.uiFontFamily,
    displaySetting?.uiFontFamilyCss,
    displaySetting?.uiFontFamilyCjkCss,
    displaySetting?.chatFontFamilyCjkCss,
  ]);

  // Tauri's WebView2 swallows `window.open` and ignores `<a target="_blank">` by default —
  // links to external pages would do nothing. Intercept every left-click on an anchor that
  // points to a real http(s) URL and route it through the shell plugin, which opens the
  // system browser. This covers anchors anywhere in the tree (citations, markdown, sidebar
  // logo, About page rows…) without each component having to know about the desktop shell.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || !/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      void openExternal(href);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  return (
    <ThemeProvider defaultTheme="light">
      <TitleBar />
      <PageTransition>
        <Outlet />
      </PageTransition>
      <WebAuthGate />
      <FontFaceInjector />
      <Toaster position="top-center" />
      <SilentUpdateChecker />
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}

export function HydrateFallback() {
  return (
    <div className="flex items-center justify-center h-screen w-screen bg-background">
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-2.5 w-2.5 rounded-full bg-primary animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="flex items-center justify-center min-h-screen bg-background p-4">
      <div className="max-w-md w-full space-y-6 text-center">
        <div className="space-y-3">
          <h1 className="text-6xl font-bold text-primary">{message}</h1>
          <p className="text-lg text-muted-foreground">{details}</p>
        </div>
        {stack && (
          <pre className="text-left text-xs bg-muted p-4 rounded-lg overflow-x-auto max-h-[400px] overflow-y-auto">
            <code className="text-muted-foreground">{stack}</code>
          </pre>
        )}
        <button
          onClick={() => (window.location.href = "/")}
          className="inline-flex items-center justify-center px-6 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90 transition-colors"
        >
          Back to Home
        </button>
      </div>
    </main>
  );
}
