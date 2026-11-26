// plugin-location.test.tsx — 插件详情信息卡的「位置」:桌面端是「打开文件夹」;浏览器访问(服务端不在这台机器上)与文件不在时
// 是「复制路径」;悬停都看得到完整路径。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PluginOverviewPanel } from "~/components/settings/extensions/plugins/detail-panels";
import { TooltipProvider } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import type { EnginePluginRecord, EnginePluginViewDto } from "~/types/plugins";

const PATH = "D:\\data\\engines\\pi\\npm\\node_modules\\pi-web-access";
const record: EnginePluginRecord = {
  id: "pi:pi-web-access",
  engine: "pi",
  name: "pi-web-access",
  source: { kind: "npm", spec: "pi-web-access" },
  version: "0.47.0",
  enabled: true,
  hookSwitches: { toolCall: true },
  toolSwitches: {},
  installedAt: "2026-11-23T00:00:00.000Z",
};

function render(view: EnginePluginViewDto): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(PluginOverviewPanel, { record, view, detail: undefined, loading: false, onShowTools: () => {} }),
    ),
  );
}

const view = (installed: boolean): EnginePluginViewDto => ({ ...record, path: PATH, installed, loadFailed: false, auditCount: 0 });
const holder = globalThis as { window?: unknown };
const originalWindow = holder.window;

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  holder.window = originalWindow;
});

describe("插件位置", () => {
  test("浏览器访问:复制路径", () => {
    const html = render(view(true));
    expect(html).toContain(i18n.t("settings:plugins.copy_path"));
    expect(html).not.toContain(i18n.t("settings:plugins.open_folder"));
    expect(html).toContain(`title="${PATH}"`);
  });

  test("桌面端:打开文件夹;文件不在时仍是复制路径", () => {
    holder.window = { __TAURI_INTERNALS__: {} };
    const html = render(view(true));
    expect(html).toContain(i18n.t("settings:plugins.open_folder"));
    expect(html).not.toContain(i18n.t("settings:plugins.copy_path"));
    expect(html).toContain(`title="${PATH}"`);
    expect(render(view(false))).toContain(i18n.t("settings:plugins.copy_path"));
  });
});
