import * as React from "react";

import { useFontCatalog } from "~/hooks/use-font-catalog";

// 把 builtin + custom 字体的 @font-face 规则注入 <head>。系统字体不需要(浏览器已能用)。
// 浏览器对 @font-face 懒加载——只有渲染用到字形时才真正下载文件,所以一次全注入不浪费带宽。
// 关键不变式:@font-face 的 font-family 名 === 后端 FontEntry.cssName === family 链首项,
// 这样 CSS 变量里写的 family 才能命中 @font-face 规则触发加载。
// 多字重字体(HarmonyOS Sans 6 个字重)共享同一 font-family,每条规则声明对应 font-weight,
// 浏览器遇到 font-weight:700 自动挑 Bold 文件,而非用 Regular 合成假粗体。
export function FontFaceInjector() {
  const { data } = useFontCatalog();
  React.useEffect(() => {
    if (!data) return;
    const entries = [...data.builtin, ...data.custom];
    const rules: string[] = [];
    for (const entry of entries) {
      for (const w of entry.weights) {
        const url = `/api/fonts/${entry.source}/${encodeURIComponent(w.fileName)}`;
        const fmt = w.format ? ` format("${w.format}")` : "";
        const styleDecl = w.style === "italic" ? " font-style: italic;" : "";
        rules.push(
          `@font-face { font-family: "${entry.cssName}"; src: url("${url}")${fmt}; font-weight: ${w.weight};${styleDecl} font-display: swap; }`,
        );
      }
    }
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
