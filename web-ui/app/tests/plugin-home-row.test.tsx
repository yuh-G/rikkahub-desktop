// plugin-home-row.test.tsx — 插件首页的行:行尾是「时间 | 开关 |「⋯」」,开关在选中按钮之外(点开关不进详情),忙碌时开关变灰、
// 「⋯」那格由空占位顶住(开关不左右跳);外层裁剪两侧留余量,行的悬停底色与返回键不被切掉。
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PluginsHomeView } from "~/components/settings/extensions/plugins/home-view";
import { TooltipProvider } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import type { Settings } from "~/types";
import type { EnginePluginRecord } from "~/types/plugins";

const PLUGINS_DIR = join(import.meta.dir, "..", "components", "settings", "extensions", "plugins");

function record(id: string, enabled: boolean): EnginePluginRecord {
  return {
    id: `pi:${id}`,
    engine: "pi",
    name: id,
    source: { kind: "npm", spec: id },
    version: "1.0.0",
    enabled,
    hookSwitches: { toolCall: true },
    toolSwitches: {},
    installedAt: "2026-11-23T00:00:00.000Z",
  };
}

const records = [record("alpha", true), record("beta", false)];

function render(): string {
  const settings = { enginePlugins: records } as unknown as Settings;
  return renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(PluginsHomeView, { settings })));
}

/** 每一行的 HTML(按 data-sort-id 切)。 */
function rowHtml(html: string, id: string): string {
  const start = html.indexOf(`data-sort-id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf("data-sort-id=", start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("插件首页的行", () => {
  test("每行一个开关,状态与记录一致;开关不在选中按钮里", () => {
    const html = render();
    const alpha = rowHtml(html, "pi:alpha");
    const beta = rowHtml(html, "pi:beta");
    expect(alpha).toContain('role="switch"');
    expect(alpha).toContain('aria-checked="true"');
    expect(beta).toContain('aria-checked="false"');
    // 选中按钮(行内第一个 <button)在开关之前就闭合了。
    const select = alpha.indexOf("<button");
    expect(alpha.indexOf("</button>", select)).toBeLessThan(alpha.indexOf('role="switch"'));
    expect(alpha).toContain(`aria-label="${i18n.t("settings:plugins.enable")}"`);
  });

  test("顺序是时间、开关、「⋯」", () => {
    const alpha = rowHtml(render(), "pi:alpha");
    const time = alpha.indexOf("<time");
    const toggle = alpha.indexOf('role="switch"');
    const more = alpha.indexOf(`aria-label="${i18n.t("settings:common.item_actions")}"`);
    expect(time).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(time);
    expect(more).toBeGreaterThan(toggle);
  });

  // 服务端渲染读的是仓库的初始快照(拿不到 setPluginBusy 设的值),忙碌态只能锁源码。
  test("忙碌时开关变灰、不给菜单,「⋯」那格由空占位顶住", () => {
    const source = readFileSync(join(PLUGINS_DIR, "home-view.tsx"), "utf8");
    expect(source).toContain("disabled={busy}");
    expect(source).toContain("actions={busy ? undefined : actions}");
    expect(source).toContain('badge={busy ? <span className="size-6" /> : undefined}');
  });

  test("「⋯」菜单里不再有启用 / 停用(行上有开关)", () => {
    const source = readFileSync(join(PLUGINS_DIR, "home-view.tsx"), "utf8");
    expect(source).not.toContain('key: "enabled"');
    expect(source).not.toContain("settings:plugins.disable");
  });

  test("外层裁剪两侧留 12px:行底色与返回键外伸的部分不被切掉", () => {
    const source = readFileSync(join(PLUGINS_DIR, "index.tsx"), "utf8");
    expect(source).toContain('className="@container -mx-3 overflow-x-clip px-3"');
  });
});
