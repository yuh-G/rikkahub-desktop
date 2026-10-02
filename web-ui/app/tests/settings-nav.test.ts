// settings-nav.test.ts — 导航表的纯函数、旧深链映射,以及表 ↔ 注册表 ↔ 文案三方一致。
import { describe, expect, test } from "bun:test";

import enSettings from "~/locales/en-US/settings.json";
import zhSettings from "~/locales/zh-CN/settings.json";
import {
  SETTINGS_NAV,
  resolveSettingsLocation,
  resolveSettingsSub,
  settingsPageKey,
  settingsSubItems,
} from "~/components/settings/settings-nav";
import { SETTINGS_PAGES } from "~/components/settings/settings-registry";

function allPageKeys(): string[] {
  return SETTINGS_NAV.flatMap((item) => {
    const subs = settingsSubItems(item.id);
    return subs.length > 0 ? subs.map((sub) => `${item.id}/${sub.id}`) : [item.id];
  });
}

describe("页键", () => {
  test("导航表推出的页键与注册表键完全一致(运行时再锁一次)", () => {
    expect(Object.keys(SETTINGS_PAGES).sort()).toEqual(allPageKeys().sort());
  });

  test("一级 id 与同一级下的二级 id 都不重复", () => {
    const ids = SETTINGS_NAV.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of SETTINGS_NAV) {
      const subIds = settingsSubItems(item.id).map((sub) => sub.id);
      expect(new Set(subIds).size).toBe(subIds.length);
    }
  });

  test("settingsPageKey 补全缺省或非法的二级", () => {
    expect(settingsPageKey("network", "port")).toBe("network/port");
    expect(settingsPageKey("network", null)).toBe("network/search");
    expect(settingsPageKey("network", "tts")).toBe("network/search");
    expect(settingsPageKey("memory", "anything")).toBe("memory");
  });
});

describe("resolveSettingsSub", () => {
  test("合法用之,非法或缺省落第一个,无二级恒 null", () => {
    expect(resolveSettingsSub("speech", "asr")).toBe("asr");
    expect(resolveSettingsSub("speech", "nope")).toBe("tts");
    expect(resolveSettingsSub("speech", undefined)).toBe("tts");
    expect(resolveSettingsSub("about", "asr")).toBeNull();
  });
});

describe("resolveSettingsLocation", () => {
  test("新格式原样解析;sub 不属于该一级时置 null", () => {
    expect(resolveSettingsLocation("?section=data&sub=server")).toEqual({ section: "data", sub: "server" });
    expect(resolveSettingsLocation("?section=data&sub=asr")).toEqual({ section: "data", sub: null });
    expect(resolveSettingsLocation("?section=memory")).toEqual({ section: "memory", sub: null });
  });

  test("缺 section 或不认识的 section 返回 null", () => {
    expect(resolveSettingsLocation("")).toBeNull();
    expect(resolveSettingsLocation("?providerId=x")).toBeNull();
    expect(resolveSettingsLocation("?section=bogus")).toBeNull();
  });

  test("旧 id 映射到新位置", () => {
    expect(resolveSettingsLocation("?section=providers&providerId=p")).toEqual({ section: "models", sub: "providers" });
    expect(resolveSettingsLocation("?section=search")).toEqual({ section: "network", sub: "search" });
    expect(resolveSettingsLocation("?section=proxy")).toEqual({ section: "network", sub: "proxy" });
    expect(resolveSettingsLocation("?section=logs")).toEqual({ section: "stats", sub: "logs" });
    // 旧 models(场景模型)与新一级同名,按新语义:交给记忆/默认二级。
    expect(resolveSettingsLocation("?section=models")).toEqual({ section: "models", sub: null });
    expect(resolveSettingsLocation("?section=stats")).toEqual({ section: "stats", sub: null });
  });

  test("旧 mcp 分区按 tab 落到拓展的二级", () => {
    expect(resolveSettingsLocation("?section=mcp&tab=mcp")).toEqual({ section: "extensions", sub: "mcp" });
    expect(resolveSettingsLocation("?section=mcp&tab=skills")).toEqual({ section: "extensions", sub: "skills" });
    expect(resolveSettingsLocation("?section=mcp&tab=quick")).toEqual({ section: "extensions", sub: "quick" });
    expect(resolveSettingsLocation("?section=mcp&tab=mode")).toEqual({ section: "extensions", sub: "injection" });
    expect(resolveSettingsLocation("?section=mcp&tab=lorebook")).toEqual({ section: "extensions", sub: "injection" });
    expect(resolveSettingsLocation("?section=mcp")).toEqual({ section: "extensions", sub: null });
  });
});

describe("导航文案", () => {
  // i18n 没有类型守卫:漏一个 key,生产环境就直接显示 key 名。
  const lookup = (bundle: unknown, labelKey: string) =>
    labelKey
      .replace(/^settings:/, "")
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], bundle);

  const labelKeys = SETTINGS_NAV.flatMap((item) => [
    item.labelKey,
    ...settingsSubItems(item.id).map((sub) => sub.labelKey),
  ]);

  for (const [locale, bundle] of [
    ["zh-CN", zhSettings],
    ["en-US", enSettings],
  ] as const) {
    test(`${locale} 覆盖全部一级与二级标签`, () => {
      const missing = labelKeys.filter((key) => typeof lookup(bundle, key) !== "string");
      expect(missing).toEqual([]);
    });
  }
});
