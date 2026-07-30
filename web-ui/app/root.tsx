import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import * as React from "react";
import i18n from "~/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Route } from "./+types/root";
import { useSettingsStore, useSettingsSubscription, useMemorySubscription, useAppErrorsSubscription } from "~/stores";
import { useHotkeys } from "~/hooks/use-hotkeys";
import "./app.css";
import "./i18n";
import { Toaster } from "./components/ui/sonner";
import { ThemeProvider } from "./components/theme-provider";
import { TitleBar } from "./components/title-bar";
import { UpdateDialog, type UpdateInfo } from "./components/update-dialog";
import { WebAuthGate } from "./components/web-auth-gate";
import { StartupGate } from "./components/startup-gate";
import { FontFaceInjector } from "./components/font-face-injector";
import { openExternal } from "./lib/external-link";
import { toast } from "sonner";
import { GlobalConfirmDialog } from "./components/global-confirm-dialog";
import { useAppErrorsStore } from "./stores/app-errors-store";
import { startUsageActivityBeacon } from "./services/usage-activity";
import api from "~/services/api";

const queryClient = new QueryClient();

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", type: "image/x-icon", sizes: "any" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  // 7-1:lang 跟随 i18n 当前语言(此前硬编码 "en");切换语言时同步 <html lang>。
  React.useEffect(() => {
    const sync = (lng: string) => {
      document.documentElement.lang = lng;
    };
    i18n.on("languageChanged", sync);
    return () => {
      i18n.off("languageChanged", sync);
    };
  }, []);
  return (
    <html lang={i18n.language}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* R1-1:Tauri 壳(lib.rs)用此旗标区分"本应用已加载"与"连接失败错误页",
            决定是否需要重导航到 sidecar 实际端口。必须内联在 <head> 里尽早执行。 */}
        <script dangerouslySetInnerHTML={{ __html: "window.__RIKKAHUB_APP__=1" }} />
        {/* 【预绘制·读侧】A 族闪动修复:重放上次会话由 AppContent 字体/缩放效果器
            (本文件,搜 "rikkahub.prepaint.v1" 写侧)算出的最终 CSS 值,让首帧根字号与
            字体链就是正确值 —— 根治"settings 快照到达后根字号突变、rem 布局(含侧边栏
            16rem 宽度)整体跳一档"的启动闪动。本脚本零业务逻辑,只做重放;计算单源在
            效果器,改键名/字段必须两侧同步。scale 与字体都写在 <html> 上:此刻 body 尚未
            解析,CSS 自定义属性沿继承链生效;效果器挂载后会在 body 覆写同值字体,html
            层仅作首帧兜底。必须内联在 <head> 里、样式表之前,保证先于首次绘制执行。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var p=JSON.parse(localStorage.getItem("rikkahub.prepaint.v1"));if(p){var d=document.documentElement;if(typeof p.scale==="number"&&isFinite(p.scale)&&p.scale>0)d.style.setProperty("--rikkahub-ui-scale",String(p.scale));if(p.uiFont)d.style.setProperty("--rikkahub-ui-font",p.uiFont);if(p.chatFont)d.style.setProperty("--rikkahub-chat-font",p.chatFont)}}catch(e){}',
          }}
        />
        <Meta />
        <Links />
        {/* 内联 splash: WebView2 启动时在 JS 就绪前就有可见内容，避免白屏。React 挂载后瞬间移除，不等动画。 */}
        <style>{`
          #splash{align-items:center;background:#fff;display:flex;height:100vh;inset:0;justify-content:center;position:fixed;width:100vw;z-index:9999}
          @media(prefers-color-scheme:dark){#splash{background:#1c1c22}}
          .sp-ld{display:flex;gap:6px}
          .sp-dt{width:10px;height:10px;border-radius:50%;background:#3b3a42;animation:sp-bnc 1.4s infinite both}
          @media(prefers-color-scheme:dark){.sp-dt{background:#d4d4d8}}
          .sp-dt:nth-child(2){animation-delay:.16s}
          .sp-dt:nth-child(3){animation-delay:.32s}
          @keyframes sp-bnc{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
        `}</style>
      </head>
      <body>
        <div id="splash">
          <div class="sp-ld">
            <div class="sp-dt"></div>
            <div class="sp-dt"></div>
            <div class="sp-dt"></div>
          </div>
        </div>
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

// 专题8:语言上报——乐观写 store(settings 镜像随之落盘)+ POST 后端;等值跳过,
// 保证快照回放触发的 languageChanged 不会回写成环。失败静默,本地已生效。
function persistLanguage(lng: string): void {
  const store = useSettingsStore.getState();
  const current = store.settings;
  if (!current || current.displaySetting?.language === lng) return;
  store.setSettings({ ...current, displaySetting: { ...current.displaySetting, language: lng } });
  void api.post<{ status: string }>("settings/display", { language: lng }).catch(() => {
    /* 离线/后端重启窗口:放弃本次落盘,下次切换或迁移重试 */
  });
}

function AppContent() {
  // 使用时长活动信标(专题6):窗口可见且聚焦时才向后端上报活动,hb 心跳据此
  // 只统计用户实际在用的时间段。详见 services/usage-activity.ts。
  React.useEffect(() => {
    startUsageActivityBeacon();
  }, []);
  // KaTeX 字体预热:字体本来在首条数学公式渲染时才按需加载,加载完成又触发
  // 全列表重排,恰好压在打开会话的关键路径上(探针实测:点击后 ~570ms 才开始
  // 拉字体,随后一波重排)。启动后的空闲期提前拉取,打开会话时字体已就位。
  React.useEffect(() => {
    if (typeof document === "undefined" || !document.fonts?.load) return;
    const warm = () => {
      void document.fonts.load('400 16px "KaTeX_Main"');
      void document.fonts.load('italic 400 16px "KaTeX_Math"');
      void document.fonts.load('400 16px "KaTeX_Size2"');
    };
    if (typeof window.requestIdleCallback === "function") {
      const h = window.requestIdleCallback(warm, { timeout: 3000 });
      return () => window.cancelIdleCallback(h);
    }
    const t = window.setTimeout(warm, 1000);
    return () => window.clearTimeout(t);
  }, []);
  useSettingsSubscription();
  useMemorySubscription();
  useAppErrorsSubscription();
  useHotkeys();
  const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
  // 专题8:界面语言权威在后端 displaySetting.language(localStorage 按 origin 隔离,
  // 改端口/端口顺延即丢)。快照 → i18n 跟随;后端尚无记录时把当前生效语言上报一次
  // (迁移旧 localStorage "lang"/浏览器推断值);用户切换语言经 languageChanged 上报。
  const dsLanguage = typeof displaySetting?.language === "string" ? displaySetting.language : undefined;
  React.useEffect(() => {
    if (displaySetting === undefined) return; // settings 尚未就绪(无镜像的首次运行)
    if (dsLanguage === undefined) {
      persistLanguage(i18n.language);
    } else if (dsLanguage !== i18n.language) {
      void i18n.changeLanguage(dsLanguage);
    }
  }, [displaySetting, dsLanguage]);
  React.useEffect(() => {
    const onChanged = (lng: string) => persistLanguage(lng);
    i18n.on("languageChanged", onChanged);
    return () => {
      i18n.off("languageChanged", onChanged);
    };
  }, []);
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
    // 界面字号缩放:写到 <html>(documentElement)上,app.css 的 :root 规则会用它计算根字号。
    // null/未配置 = 不写变量 = CSS fallback 为 1,根字号保持 16px 浏览器默认,视觉零差异。
    const uiScale = Number(displaySetting?.uiFontSize);
    if (Number.isFinite(uiScale) && uiScale > 0 && uiScale !== 1) {
      document.documentElement.style.setProperty("--rikkahub-ui-scale", String(uiScale));
    } else {
      // 显式清掉,确保从"已缩放"回到"默认"时根字号恢复 16px。
      document.documentElement.style.removeProperty("--rikkahub-ui-scale");
    }
    // 【预绘制·写侧】把本效果器算出的最终 CSS 值持久化,供 Layout <head> 内联脚本
    // (搜 "rikkahub.prepaint.v1" 读侧)在下次启动首帧前原样重放。settings 尚未就绪
    // (无镜像的首次运行)时跳过,避免用默认值覆盖上次的真实值。失败静默(尽力而为)。
    if (displaySetting !== undefined) {
      try {
        localStorage.setItem(
          "rikkahub.prepaint.v1",
          JSON.stringify({
            scale: Number.isFinite(uiScale) && uiScale > 0 && uiScale !== 1 ? uiScale : null,
            uiFont,
            chatFont,
          }),
        );
      } catch {
        /* 配额/隐私模式:预绘制缓存缺失仅退化为旧行为 */
      }
    }
  }, [
    displaySetting?.chatFontFamily,
    displaySetting?.chatFontFamilyCss,
    displaySetting?.uiFontFamily,
    displaySetting?.uiFontFamilyCss,
    displaySetting?.uiFontFamilyCjkCss,
    displaySetting?.chatFontFamilyCjkCss,
    displaySetting?.uiFontSize,
  ]);

  // React 挂载后直接移除内联 splash（瞬间移除，无过渡，避免白屏/重影）
  React.useEffect(() => {
    const el = document.getElementById('splash');
    if (el) el.remove();
  }, []);

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

  // 7-3:未捕获的 Promise 拒绝一网兜底——toast 提示 + 进错误中心(仅本地聚合)。
  // 各消息动作已有就地 catch,这里兜的是漏网之鱼,避免"点了没反应"的静默失败。
  // R6-4:AbortError 直接忽略(导航/组件卸载取消请求属正常流,toast 只会制造噪音);
  // 同 message 30s 内合并进既有条目且不重复 toast(合并逻辑在 reportLocalError)。
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      if (reason instanceof Error && reason.name === "AbortError") return;
      const message = reason instanceof Error ? reason.message : String(reason);
      const isNewEntry = useAppErrorsStore.getState().reportLocalError({
        id: crypto.randomUUID(),
        at: Date.now(),
        count: 1,
        severity: "error",
        domain: "internal",
        message,
      });
      if (isNewEntry) toast.error(message);
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  return (
    <ThemeProvider defaultTheme="light">
      <TitleBar />
      {/* 路由切换即时呈现,不做过渡动画(专题1 B 族终案):AnimatePresence mode="wait" 的
          串行动画(旧页淡出→新页淡入)必然穿越空白帧,在整页切换场景被感知为闪动;
          成熟桌面应用的主区域切换均为即时切换 —— React 单次提交内旧页换新页,
          不存在中间帧,是唯一确定性零闪的形态。 */}
      <Outlet />
      <WebAuthGate />
      <StartupGate />
      <FontFaceInjector />
      <Toaster position="top-center" />
      <GlobalConfirmDialog />
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
