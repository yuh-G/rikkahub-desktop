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
import { useSettingsStore, useSettingsSubscription, useMemorySubscription, useAppErrorsSubscription, useMcpHealthSubscription } from "~/stores";
import { useHotkeys } from "~/hooks/use-hotkeys";
import "./app.css";
import "./i18n";
import { Toaster } from "./components/ui/sonner";
import { ThemeProvider } from "./components/theme-provider";
import { TooltipProvider } from "./components/ui/tooltip";
import { UpdateDialog, type UpdateInfo } from "./components/update-dialog";
import { WebAuthGate } from "./components/web-auth-gate";
import { ExposedBanner } from "./components/exposed-banner";
import { StartupGate } from "./components/startup-gate";
import Logo from "./components/logo";
import { FontFaceInjector } from "./components/font-face-injector";
import { openExternal } from "./lib/external-link";
import { createId } from "./lib/id";
import {
  CHAT_CJK_OVERRIDE_FAMILY,
  composeFontChain,
  UI_CJK_OVERRIDE_FAMILY,
} from "./lib/font-chain";
import { toast } from "sonner";
import { GlobalConfirmDialog } from "./components/global-confirm-dialog";
import { useAppErrorsStore } from "./stores/app-errors-store";
import { startUsageActivityBeacon } from "./services/usage-activity";
import { useApprovalNotifications } from "./lib/approval-notification";
import api from "~/services/api";
import {
  LEGACY_RELAY_KEYS,
  ORIGIN_RELAY_KEYS,
  RELAY_QUERY_KEY,
  RELAY_SCRIPT_ID,
} from "@server/foundation/origin-relay";

const queryClient = new QueryClient();

// 【origin 接力·导入脚本】见 Layout 里 <head> 首个脚本的注释。内联串在模块装配期拼好:
// 白名单/键名经 JSON.stringify 嵌入,无手拼引号;两个 try 各自兜底(隐私模式下
// localStorage 抛错、非常规 URL),失败只是不导入/URL 留参,页面照常起。
const ORIGIN_RELAY_KEYS_JSON = JSON.stringify([...ORIGIN_RELAY_KEYS, ...LEGACY_RELAY_KEYS]);
const ORIGIN_RELAY_IMPORT_SCRIPT =
  `try{var el=document.getElementById(${JSON.stringify(RELAY_SCRIPT_ID)});if(el){` +
  `var d=JSON.parse(el.textContent||"{}"),k=${ORIGIN_RELAY_KEYS_JSON};` +
  `for(var i=0;i<k.length;i++)if(typeof d[k[i]]==="string")localStorage.setItem(k[i],d[k[i]]);el.remove()}}catch(e){}` +
  `try{var u=new URL(location.href);if(u.searchParams.has(${JSON.stringify(RELAY_QUERY_KEY)})){` +
  `u.searchParams.delete(${JSON.stringify(RELAY_QUERY_KEY)});` +
  `history.replaceState(history.state,"",u.pathname+u.search+u.hash)}}catch(e){}`;

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
        {/* 【origin 接力·导入】服务端在 <head> 开头注入过数据块时,同步写回白名单
            localStorage 并删除数据块,再剥掉凭证查询参数。必须是 <head> 第一个脚本——
            下方两段预绘制脚本要读到搬来的值,标签 store 模块初始化时读到的就是旧布局。
            导入是覆盖(用户最后待在旧 origin,旧数据才是最新);无数据块时零操作,
            日常启动恒走空路径。白名单与键名从服务端纯模块 @server 引用,单一来源。 */}
        <script dangerouslySetInnerHTML={{ __html: ORIGIN_RELAY_IMPORT_SCRIPT }} />
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
        {/* 【预绘制·读侧】明暗模式:重放 ThemeProvider applyMode(写侧,搜同键名)上次
            算出的最终明暗值,首帧前把 .dark 挂上 <html> —— 根治暗色用户冷启动的白闪。
            缺键(首次运行)不动,默认即 light,与 <ThemeProvider defaultTheme="light"> 一致。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("rikkahub.prepaint.theme.v1")==="dark")document.documentElement.classList.add("dark")}catch(e){}',
          }}
        />
        {/* 启动加载屏关键 CSS:HydrateFallback(本文件末尾)被 SPA 预渲染进 index.html,
            在 JS 下载/解析完成前就已在 DOM 里,但它此前依赖 app.css 的 Tailwind 类 ——
            CSS 未就绪时就是白屏。这里内联自包含样式(色值取自 app.css 默认主题的
            --background/--foreground/--muted-foreground),让加载屏零依赖、随 HTML 解析
            即刻可见;水合完成后 React Router 自动以真实应用替换,无需手动移除逻辑。
            版式:品牌行(Logo + 应用名)居中,加载圆点缀于下方;translateY(-6%) 做光学
            居中——品牌组整体略高于几何中心,与成熟桌面应用启动屏的视觉重心一致。
            对齐(数据驱动,非目测):Logo 原 viewBox 四周各留 ~89 单位空白,HydrateFallback
            处以墨迹边界(getBBox + 描边余量)裁剪 viewBox,SVG 盒即兔子可见边界;实测
            system-ui(Segoe UI) 650 字重下 "RikkaHub" 墨迹高 ≈ 0.82em,故字号 = 兔高/0.82,
            让文字上边线对齐兔耳、下边线对齐兔底。尺寸全用 px:此刻 app.css 未加载,
            rem 会在样式表就绪、根字号缩放生效的瞬间跳档。字体用系统栈,零加载零闪动。 */}
        <style
          dangerouslySetInnerHTML={{
            __html: [
              "#rikkahub-splash{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:44px;background:oklch(.992 .002 240);color:oklch(.18 .005 240)}",
              ".dark #rikkahub-splash{background:oklch(.12 .006 240);color:oklch(.93 .006 240)}",
              "#rikkahub-splash .sp-brand{display:flex;align-items:center;gap:16px;transform:translateY(-6%)}",
              "#rikkahub-splash .sp-brand svg{width:38px;height:54px}",
              '#rikkahub-splash .sp-brand span{font:650 48px/1 system-ui,"Segoe UI",-apple-system,sans-serif;letter-spacing:-.02em}',
              "#rikkahub-splash .sp-dots{display:flex;gap:7px}",
              "#rikkahub-splash .sp-dots i{width:9px;height:9px;border-radius:9999px;background:oklch(.55 .01 240);animation:rikkahub-splash-bounce 1s infinite}",
              ".dark #rikkahub-splash .sp-dots i{background:oklch(.65 .01 240)}",
              "@keyframes rikkahub-splash-bounce{0%,100%{transform:translateY(-30%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}",
            ].join("\n"),
          }}
        />
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
      // D9(复查):补齐常用字体族——Size1/3/4(定界符与大算符各档)与 AMS(黑板体/特殊
      // 符号),否则首次遇到 mathbb 或多层定界符仍会触发按需加载+整列重排。空闲期预取,
      // 每个 woff2 仅十几 KB 且走本地服务,代价可忽略。
      void document.fonts.load('400 16px "KaTeX_Size1"');
      void document.fonts.load('400 16px "KaTeX_Size2"');
      void document.fonts.load('400 16px "KaTeX_Size3"');
      void document.fonts.load('400 16px "KaTeX_Size4"');
      void document.fonts.load('400 16px "KaTeX_AMS"');
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
  useMcpHealthSubscription();
  // 域4-1(交互审查 2A):审批等待的桌面通知(窗口不可见时),琥珀点外显在侧栏/标签条。
  useApprovalNotifications();
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
    } else {
      if (dsLanguage !== i18n.language) {
        void i18n.changeLanguage(dsLanguage);
      }
      // A3 收尾(专题8复查):语言权威已落在后端/镜像,旧 "lang" 键使命完成——清除,
      // 与主题侧 clearLegacyPrefs 对称(此前只删写入不删旧键,兜底读取永不失效)。
      try {
        window.localStorage.removeItem("lang");
      } catch {
        /* 隐私模式:残留无害 */
      }
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
    // 中英文分别设置(Word 式):中文字体经 unicode-range 覆盖族生效(原理见 lib/font-chain.ts,
    // @font-face 注入见 FontFaceInjector):覆盖族置于链首,中文字形命中它、拉丁字形穿透到
    // 英文字体。没设中文字体 → 纯英文链,行为同前(向后兼容)。
    const uiEn = String(
      displaySetting?.uiFontFamilyCss ?? displaySetting?.uiFontFamily ?? "",
    ).trim();
    const chatEn = String(
      displaySetting?.chatFontFamilyCss ?? displaySetting?.chatFontFamily ?? "",
    ).trim();
    const uiCjk = String(displaySetting?.uiFontFamilyCjkCss ?? "").trim();
    const chatCjk = String(displaySetting?.chatFontFamilyCjkCss ?? "").trim();
    // 默认(跟随系统)= var(--font-sans):即 NewMax 默认链(Inter Variable 起链,
    // 中文由链内 Noto Sans SC Variable 兜底)。曾把 Noto Sans SC/微软雅黑 排链首,
    // 拉丁字形永远命中中文字体、轮不到 Inter,英文观感与 NewMax 不符(G10)。
    const uiFont = composeFontChain(
      uiEn || "var(--font-sans)",
      UI_CJK_OVERRIDE_FAMILY,
      Boolean(uiCjk),
    );
    // 对话字体:英文未设时基链取界面链(继承观感);都未设且无中文 → inherit(纯继承,零成本)。
    const chatFont = chatCjk
      ? composeFontChain(chatEn || uiFont, CHAT_CJK_OVERRIDE_FAMILY, true)
      : chatEn || "inherit";
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
        id: createId(),
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
      {/* G7 全局 Tooltip 配置:500ms 出场延迟,300ms 内连续悬停免延迟(浏览器原生手感)。
          sidebar 子树内嵌的 Provider(0ms)就近覆盖,不受影响。 */}
      <TooltipProvider delayDuration={500} skipDelayDuration={300}>
      {/* 路由切换即时呈现,不做过渡动画(专题1 B 族终案):AnimatePresence mode="wait" 的
          串行动画(旧页淡出→新页淡入)必然穿越空白帧,在整页切换场景被感知为闪动;
          成熟桌面应用的主区域切换均为即时切换 —— React 单次提交内旧页换新页,
          不存在中间帧,是唯一确定性零闪的形态。 */}
      <Outlet />
      <ExposedBanner />
      <WebAuthGate />
      <StartupGate />
      <FontFaceInjector />
      <Toaster position="top-center" />
      <GlobalConfirmDialog />
      <SilentUpdateChecker />
      </TooltipProvider>
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

// 启动加载屏:样式完全来自 Layout <head> 的内联关键 CSS(不依赖 app.css),
// 因此从 index.html 解析那一刻起就能正确显示,覆盖"CSS/JS 尚未就绪"的空窗期。
// Logo 组件 fill/stroke 均为 currentColor,预渲染成静态 SVG 后随容器 color 明暗自适应。
// 双生子约束:web-ui/public/splash.html(Tauri 壳启动页,窗口创建到后端就绪之间的
// 占位)与本屏逐像素一致——版式/色值/字号/动画任一处改动,两边同步改(那里是原生
// HTML,暗色走 prefers-color-scheme 而非 .dark 类)。
export function HydrateFallback() {
  return (
    <div id="rikkahub-splash">
      <div className="sp-brand">
        {/* viewBox 裁到墨迹边界(getBBox x237 y89 w660 h956,外扩 10 单位描边余量),
            SVG 盒 = 兔子可见边界,flex 垂直居中即墨迹居中,文字对齐才有可靠基准 */}
        <Logo aria-hidden viewBox="227 79 680 976" />
        <span>RikkaHub</span>
      </div>
      <div className="sp-dots">
        {[0, 1, 2].map((i) => (
          <i key={i} style={{ animationDelay: `${i * 0.15}s` }} />
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
