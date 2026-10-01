import * as React from "react";

const MOBILE_BREAKPOINT = 768;
// 与 Tailwind 的 md 断点同值(48rem;媒体查询里的 rem 按浏览器初始字号算,不受 UI 缩放影响)。
const DESKTOP_QUERY = `(min-width: ${MOBILE_BREAKPOINT}px)`;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

/** 非 React 场景(点击处理器、全局快捷键)的即时判定。 */
export function isDesktopViewport(): boolean {
  return typeof window === "undefined" || window.matchMedia(DESKTOP_QUERY).matches;
}

function subscribeDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * md 及以上为 true。与 useIsMobile 不同,首帧即为真值(useSyncExternalStore 同步读),
 * 用于"渲染哪一棵组件树"这类不能先错一帧再纠正的分叉。
 */
export function useIsDesktop(): boolean {
  return React.useSyncExternalStore(subscribeDesktop, isDesktopViewport, () => true);
}
