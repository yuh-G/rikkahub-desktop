import * as React from "react";

import { useFontCatalog } from "~/hooks/use-font-catalog";

// 把 builtin + custom 字体的 @font-face 规则注入 <head>。系统字体不需要(浏览器已能用)。
// 浏览器对 @font-face 懒加载——只有渲染用到字形时才真正下载文件,所以一次全注入不浪费带宽。
// 关键不变式:@font-face 的 font-family 名 === 后端 FontEntry.cssName === family 链首项,
// 这样 CSS 变量里写的 family 才能命中 @font-face 规则触发加载。
export function FontFaceInjector() {
  const { data } = useFontCatalog();
  React.useEffect(() => {
    if (!data) return;
    const entries = [...data.builtin, ...data.custom];
    const rules = entries
      .filter((entry) => entry.fileName)
      .map((entry) => {
        const url = `/api/fonts/${entry.source}/${encodeURIComponent(entry.fileName!)}`;
        const fmt = entry.format ? ` format("${entry.format}")` : "";
        return `@font-face { font-family: "${entry.cssName}"; src: url("${url}")${fmt}; font-display: swap; }`;
      });
    let style = document.getElementById("rikkahub-font-faces") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "rikkahub-font-faces";
      document.head.appendChild(style);
    }
    style.textContent = rules.join("\n");
  }, [data]);
  return null;
}
