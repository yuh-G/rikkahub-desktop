// plugin-detail-layout.test.tsx — 插件详情概览的版式:「说明」小标题占整宽一行;信息卡浮在右上,正文绕着它排、过了卡片铺满整宽;
// README 第一块不留上边距(与卡片顶边对齐);已安装与市场条目两处详情共用同一套版式,不各写一份。
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

  // 绕排全靠 className(jsdom 不跑 Tailwind,也不排版),锁源码里的关键类。
  test("绕排:卡片浮在右上,README 容器不自成格式化上下文,带框线的块让开卡片", () => {
    const parts = readFileSync(join(PLUGINS_DIR, "parts.tsx"), "utf8");
    expect(parts).toContain("@min-[40rem]:float-right");
    // overflow: hidden 会让整块 README 缩在卡片左边,不绕排。
    expect(parts).toContain('"overflow-clip text-sm');
    expect(parts).not.toContain('"overflow-hidden text-sm');
    expect(parts).toContain("[&_.markdown>*>:is(h2,hr,p:has(img),div:has(img),.footnotes)]:flow-root");
    expect(parts).toContain("[&_.code-block]:w-auto");
    // 收起时的渐隐遮罩盖在卡片上面会挡住链接,卡片要压在上面。
    expect(parts).toContain('className="relative z-[1] mb-6');
    expect(readFileSync(join(PLUGINS_DIR, "detail-panels.tsx"), "utf8")).toContain('className="flow-root"');
  });

  test("渲染顺序:卡片在正文之前(浮动要先出现;窄的时候卡片在上)", () => {
    const html = render();
    expect(html.indexOf(i18n.t("settings:plugins.info_title"))).toBeLessThan(html.indexOf("Demo Title"));
  });
});
