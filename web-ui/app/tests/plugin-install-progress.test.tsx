// plugin-install-progress.test.tsx — 插件安装的进度环:有计数画到比例、没有计数转一小段弧;悬停说明写清第几步与计数;
// 进度只记在忙碌中的键上,忙碌结束随之清掉;文案键两种语言成对。
import { beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProgressGlyph, progressFraction, progressLabel } from "~/components/settings/extensions/plugins/install-progress";
import i18n from "~/i18n";
import en from "~/locales/en-US/settings.json";
import zh from "~/locales/zh-CN/settings.json";
import { setPluginBusy, setPluginInstallProgress, usePluginsViewStore } from "~/stores/plugins-view-store";
import type { PluginInstallProgressDto } from "~/types/plugins";

const t = i18n.t.bind(i18n) as unknown as (key: string, options?: Record<string, unknown>) => string;
const KEY = "market:pi-official:demo";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  setPluginBusy(KEY, false);
});

describe("插件安装进度", () => {
  test("说明写第几步、在做什么、数到多少;下载段另起一行写正在取的包", () => {
    expect(progressLabel(undefined, t)).toBe("准备安装");
    expect(progressLabel({ phase: "download", done: 120, total: 194, item: "ajv" }, t)).toBe("第 1/3 步 · 下载依赖 120/194 个包\najv");
    expect(progressLabel({ phase: "install", done: 80, total: 210 }, t)).toBe("第 2/3 步 · 放进插件目录 80/210 个包");
    expect(progressLabel({ phase: "check", done: 0, total: 0 }, t)).toBe("第 3/3 步 · 检查插件");
    expect(progressFraction({ phase: "install", done: 211, total: 210 })).toBe(1);
    expect(progressFraction({ phase: "check", done: 0, total: 0 })).toBeNull();
  });

  test("进度只记在忙碌中的键上,忙碌结束即清掉", () => {
    setPluginInstallProgress(KEY, { phase: "install", done: 1, total: 2 });
    expect(usePluginsViewStore.getState().installProgress[KEY]).toBeUndefined();
    setPluginBusy(KEY, true);
    setPluginInstallProgress(KEY, { phase: "install", done: 1, total: 2 });
    expect(usePluginsViewStore.getState().installProgress[KEY]).toEqual({ phase: "install", done: 1, total: 2 });
    setPluginBusy(KEY, false);
    expect(usePluginsViewStore.getState().installProgress[KEY]).toBeUndefined();
  });

  test("有计数画到对应比例,没有计数是转着的一小段弧", () => {
    const glyph = (progress?: PluginInstallProgressDto) => renderToStaticMarkup(React.createElement(ProgressGlyph, { progress }));
    expect(glyph()).toContain("animate-spin");
    expect(glyph({ phase: "download", done: 1, total: 4 })).toContain('data-fraction="0.25"');
    expect(glyph({ phase: "download", done: 1, total: 4 })).not.toContain("animate-spin");
    expect(glyph({ phase: "check", done: 0, total: 0 })).toContain("animate-spin");
  });

  test("文案键两种语言成对", () => {
    const keys = (locale: unknown) => Object.keys((locale as { plugins: { progress: Record<string, string> } }).plugins.progress).sort();
    expect(keys(en)).toEqual(keys(zh));
    expect(keys(zh)).toEqual(["check", "download", "download_count", "install", "install_count", "starting", "step"]);
  });
});
