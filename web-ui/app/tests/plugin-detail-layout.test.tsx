// plugin-detail-layout.test.tsx — 插件详情概览的版式:「说明」小标题占整宽一行,正文与信息卡在它下面并排(顶边对齐);
// README 第一块不留上边距;已安装与市场条目两处详情共用同一套版式,不各写一份。
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PluginOverviewPanel } from "~/components/settings/extensions/plugins/detail-panels";
import { TooltipProvider } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import type { EnginePluginDetailDto, EnginePluginRecord } from "~/types/plugins";

const PLUGINS_DIR = join(import.meta.dir, "..", "components", "settings", "extensions", "plugins");

const record: EnginePluginRecord = {
  id: "pi:demo",
  engine: "pi",
  name: "demo",
  source: { kind: "npm", spec: "demo" },
  version: "1.0.0",
  enabled: true,
  hookSwitches: { toolCall: true },
  toolSwitches: {},
  installedAt: "2026-11-23T00:00:00.000Z",
};

const detail = {
  readme: '<p>\n  <img src="banner.png">\n</p>\n\n# Demo Title\n\nBody text.',
  tools: [],
  commands: [],
  mcpServers: [],
  audit: [],
  errors: [],
} as unknown as EnginePluginDetailDto;

function render(): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(PluginOverviewPanel, { record, view: undefined, detail, loading: false, onShowTools: () => {} }),
    ),
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("插件详情概览的版式", () => {
  test("「说明」小标题在正文与信息卡之前,信息卡与正文同处一行", () => {
    const html = render();
    const heading = html.indexOf(i18n.t("settings:plugins.readme_title"));
    const title = html.indexOf("Demo Title");
    const card = html.indexOf(i18n.t("settings:plugins.info_title"));
    expect(heading).toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(heading);
    expect(card).toBeGreaterThan(heading);
  });

  test("横幅图删掉后不留空段落,README 第一块是标题", () => {
    const html = render();
    expect(html).not.toContain("banner.png");
    const body = html.slice(html.indexOf("space-y-4 whitespace-normal"));
    expect(body.indexOf("<p")).toBeGreaterThan(body.indexOf("Demo Title"));
  });

  test("README 第一块的上边距压掉;两处详情都用 ReadmeWithInfo + InfoCard", () => {
    const parts = readFileSync(join(PLUGINS_DIR, "parts.tsx"), "utf8");
    expect(parts).toContain("[&_.markdown>*>:first-child]:mt-0!");
    for (const file of ["detail-panels.tsx", "market-detail-view.tsx"]) {
      const source = readFileSync(join(PLUGINS_DIR, file), "utf8");
      expect(source).toContain("<ReadmeWithInfo");
      expect(source).toContain("<InfoCard>");
      expect(source).not.toContain('t("settings:plugins.readme_title")');
    }
  });
});
