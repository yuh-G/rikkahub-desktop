// 供应商页高级区的「缓存预热」这一行(方案 §5.17.6):哪些供应商显示、说明用哪一句、何时让高级区亮小圆点。
// 默认值与资格来自服务端同一个模块(model-providers/prompt-cache-defaults.ts),这里锁界面怎么用它。
import { describe, expect, test } from "bun:test";

import { cacheWarmingRowOf } from "~/components/settings/providers/common";
import type { ProviderProfile } from "~/types";
import zh from "~/locales/zh-CN/settings.json";
import en from "~/locales/en-US/settings.json";

const row = (overrides: Partial<ProviderProfile>) =>
  cacheWarmingRowOf({ id: "p", enabled: true, name: "P", models: [], type: "claude", baseUrl: "https://api.anthropic.com/v1", ...overrides } as ProviderProfile);
const OFFICIAL = "settings:providers.prompt_cache_warming_desc_official";
const OTHER = "settings:providers.prompt_cache_warming_desc_other";
const subscription = (flow: string, extra: Partial<ProviderProfile> = {}) =>
  row({ authMode: "oauth", oauthStatus: { signedIn: true, flow, signedInAt: 1 } as ProviderProfile["oauthStatus"], ...extra });

describe("缓存预热这一行", () => {
  test("官方端点:默认显示且开着,说明用官方那句,不亮小圆点;关掉后亮", () => {
    expect(row({})).toEqual({ visible: true, checked: true, nonDefault: false, descriptionKey: OFFICIAL });
    expect(row({ promptCacheWarming: false })).toMatchObject({ checked: false, nonDefault: true });
  });

  test("官方端点关了缓存:这一行不显示,也不亮小圆点", () => {
    expect(row({ promptCaching: false })).toMatchObject({ visible: false, nonDefault: false });
  });

  test("中转站:缓存不填(= 关)时不显示;开了缓存才显示,默认关、说明用其余端点那句;打开后亮小圆点", () => {
    const relay = { baseUrl: "https://relay.example.com/v1" };
    expect(row(relay).visible).toBe(false);
    expect(row({ ...relay, promptCaching: true })).toEqual({ visible: true, checked: false, nonDefault: false, descriptionKey: OTHER });
    expect(row({ ...relay, promptCaching: true, promptCacheWarming: true })).toMatchObject({ checked: true, nonDefault: true });
  });

  test("Claude 订阅显示、默认开、说明用官方那句;其余订阅(Kimi Code 同为 Claude 格式)不显示", () => {
    expect(subscription("anthropic")).toEqual({ visible: true, checked: true, nonDefault: false, descriptionKey: OFFICIAL });
    expect(subscription("anthropic", { promptCacheWarming: false })).toMatchObject({ checked: false, nonDefault: true });
    expect(subscription("kimi-coding").visible).toBe(false);
  });

  test("OpenAI / Google 格式不显示", () => {
    expect(row({ type: "openai", baseUrl: "https://api.openai.com/v1" }).visible).toBe(false);
    expect(row({ type: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }).visible).toBe(false);
  });

  test("两句说明的中英文都在", () => {
    for (const locale of [zh, en]) {
      expect(locale.providers.prompt_cache_warming_title).toBeTruthy();
      expect(locale.providers.prompt_cache_warming_desc_official).toBeTruthy();
      expect(locale.providers.prompt_cache_warming_desc_other).toBeTruthy();
    }
    expect(zh.providers.prompt_cache_warming_desc_official).toBe("会话会在缓存到期前重发一次请求续期，以节省费用。");
    expect(zh.providers.prompt_cache_warming_desc_other).toBe(
      "若上游供应商会保留 Anthropic 缓存，开启后，工作区会话会在缓存到期前重发一次请求续期，以节省费用。",
    );
  });
});
