// plugin-guide.test.tsx — 插件使用说明(P7.3.2):节与条目的键两种语言齐全、没有多余的;引用的界面名字都解析出来了;
// 说明里写的时长与次数与引擎监管器的取值一致(改了监管器的取值,这里会红,提醒改说明);首页与详情概览有入口。
import { beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PLUGIN_GUIDE_SECTIONS, PluginGuideContent } from "~/components/settings/extensions/plugins/guide-dialog";
import { PluginsHomeView } from "~/components/settings/extensions/plugins/home-view";
import { TooltipProvider } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import en from "~/locales/en-US/settings.json";
import zh from "~/locales/zh-CN/settings.json";
import type { Settings } from "~/types";
import { SUPERVISOR_TIMING } from "@server/subprocess-engine/supervisor";

type Tree = { [key: string]: string | Tree };

function guideItemKeys(guide: Tree): string[] {
  return Object.entries(guide)
    .filter(([, value]) => typeof value === "object")
    .flatMap(([section, items]) => Object.keys(items as Tree).filter((item) => item !== "title").map((item) => `${section}.${item}`));
}

const declared = PLUGIN_GUIDE_SECTIONS.flatMap((section) => section.items.map((item) => `${section.id}.${item}`)).sort();

const renderGuide = () => renderToStaticMarkup(React.createElement(PluginGuideContent));

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("插件使用说明", () => {
  test("每节每条在两种语言里都有,文案里也没有没列出来的条目", () => {
    for (const locale of [zh, en]) {
      const guide = (locale as unknown as { plugins: { guide: Tree } }).plugins.guide;
      expect(guideItemKeys(guide).sort()).toEqual(declared);
      for (const section of PLUGIN_GUIDE_SECTIONS) expect(typeof (guide[section.id] as Tree).title).toBe("string");
    }
  });

  test("引用的界面名字都解析成了原文案,没有露出 $t 或键名", async () => {
    for (const lng of ["zh-CN", "en-US"]) {
      await i18n.changeLanguage(lng);
      const html = renderGuide() + i18n.t("settings:plugins.guide.intro");
      expect(html).not.toContain("$t(");
      expect(html).not.toContain("plugins.guide.");
      expect(html).toContain(i18n.t("input:workspace_permission.confirm_each"));
      expect(html).toContain(i18n.t("message:tool_part.always_allow"));
      expect(html).toContain(i18n.t("settings:plugins.tab_audit"));
    }
  });

  test("时长与次数与引擎监管器一致", async () => {
    const idle = SUPERVISOR_TIMING.idleReclaimMs / 60_000;
    const quiet = SUPERVISOR_TIMING.unresponsiveAfterMs / 1000;
    const hung = SUPERVISOR_TIMING.restartAfterMs / 1000;
    const loops = SUPERVISOR_TIMING.crashLoopLimit;
    const windowMinutes = SUPERVISOR_TIMING.crashLoopWindowMs / 60_000;
    const zhText = renderGuide();
    for (const fact of [`闲置 ${idle} 分钟`, `${quiet} 秒没有回应`, `${hung} 秒仍没有回应`, `连续 ${loops} 次`, `${windowMinutes} 分钟内出事 ${loops} 次`]) {
      expect(zhText).toContain(fact);
    }
    await i18n.changeLanguage("en-US");
    const enText = renderGuide();
    for (const fact of [`${idle} minutes idle`, `for ${quiet} seconds`, `after ${hung} seconds`, `${loops} times`, `${loops} failures within ${windowMinutes} minutes`]) {
      expect(enText).toContain(fact);
    }
  });

  test("插件首页标题下有入口", () => {
    const settings = { enginePlugins: [] } as unknown as Settings;
    const html = renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(PluginsHomeView, { settings })));
    expect(html).toContain(i18n.t("settings:plugins.guide_entry"));
  });
});
