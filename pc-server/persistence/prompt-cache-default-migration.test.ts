// persistence/prompt-cache-default-migration.test.ts — 「Claude 提示缓存」官方端点默认开的一次性迁移与备份口径
// (方案 §5.17.3 / §5.17.7,D31)。锁:①只动 Claude 格式、API Key、官方主机上存着的 false;②只跑一次(标记在场后
// 用户再关不被改回);③加载不再把不填压成 false;④给 APP 端的导出写生效值;⑤桌面端备份带上迁移标记,恢复新备份
// 不再改用户的选择,旧备份没带标记则重跑。

import { describe, expect, test } from "bun:test";

import { backupPayloadMetadataOnly, PC_AVATAR_TYPE_TO_ANDROID, rewriteAvatarsInSettings } from "../backup/export";
import { setState, state } from "./json-store";
import { BACKUP_CARRIED_MIGRATIONS, normalizeState, PROMPT_CACHE_OFFICIAL_DEFAULT_MIGRATION } from "./state-load";

const ANTHROPIC_PRESET = "b2c7e1a4-9f3d-4a6e-8c1b-5d7f9e2a3b14";
const CLAUDE_SUBSCRIPTION = "d4f86913-80d5-45e4-84ea-3e652ac63cda"; // OAUTH_FLOWS.anthropic.presetProviderId

const claude = (id: string, baseUrl: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, type: "claude", baseUrl, apiKey: "sk", models: [], ...extra }) as any;

function upgradedState(providers: unknown[], appliedMigrations: string[] = []) {
  return normalizeState({ appliedMigrations, settings: { providers, assistants: [] } } as any);
}

const find = (s: { settings: { providers: Array<{ id: string }> } }, id: string) => s.settings.providers.find((p) => p.id === id) as any;

describe("一次性迁移", () => {
  test("官方端点存着的 false 改成不填;中转站的 false、用户开着的 true、OpenAI 格式都不动", () => {
    const s = upgradedState([
      claude(ANTHROPIC_PRESET, "https://api.anthropic.com/v1", { promptCaching: false }),
      claude("custom-official", "https://api.anthropic.com", { promptCaching: false }),
      claude("relay", "https://relay.example.com/v1", { promptCaching: false }),
      claude("relay-on", "https://relay.example.com/v1", { promptCaching: true }),
      { id: "openai", name: "o", type: "openai", baseUrl: "https://api.anthropic.com/v1", apiKey: "", models: [], promptCaching: false },
    ]);
    expect("promptCaching" in find(s, ANTHROPIC_PRESET)).toBe(false);
    expect("promptCaching" in find(s, "custom-official")).toBe(false);
    expect(find(s, "relay").promptCaching).toBe(false);
    expect(find(s, "relay-on").promptCaching).toBe(true);
    expect(find(s, "openai").promptCaching).toBe(false);
    expect(s.appliedMigrations).toContain(PROMPT_CACHE_OFFICIAL_DEFAULT_MIGRATION);
  });

  test("订阅行不动(它们的字段不起作用,订阅缓存由授权恒开)", () => {
    const s = upgradedState([claude(CLAUDE_SUBSCRIPTION, "https://api.anthropic.com/v1", { promptCaching: false, authMode: "oauth" })]);
    expect(find(s, CLAUDE_SUBSCRIPTION).promptCaching).toBe(false);
  });

  test("只跑一次:标记在场时用户后来关掉的官方端点缓存保持关", () => {
    const once = upgradedState([claude("official", "https://api.anthropic.com/v1", { promptCaching: false })]);
    expect("promptCaching" in find(once, "official")).toBe(false);
    const userTurnedOff = structuredClone(once) as any;
    find(userTurnedOff, "official").promptCaching = false;
    const twice = normalizeState(userTurnedOff);
    expect(find(twice, "official").promptCaching).toBe(false);
    expect((twice.appliedMigrations ?? []).filter((m) => m === PROMPT_CACHE_OFFICIAL_DEFAULT_MIGRATION)).toHaveLength(1);
  });

  test("加载不再把不填压成 false;非布尔的脏值丢掉", () => {
    const s = upgradedState(
      [claude("relay-unset", "https://relay.example.com"), claude("junk", "https://relay.example.com", { promptCaching: "yes" })],
      [PROMPT_CACHE_OFFICIAL_DEFAULT_MIGRATION],
    );
    expect("promptCaching" in find(s, "relay-unset")).toBe(false);
    expect("promptCaching" in find(s, "junk")).toBe(false);
  });

  test("全新安装:预置的 Anthropic 行不带 promptCaching(= 开)", () => {
    const s = upgradedState([]);
    expect("promptCaching" in find(s, ANTHROPIC_PRESET)).toBe(false);
  });
});

describe("备份口径", () => {
  test("给 APP 端:Claude 行写生效值(官方不填 → true,中转站不填 → false,显式值原样),订阅行剥掉 authMode 前先算", () => {
    const out = rewriteAvatarsInSettings({
      providers: [
        claude("official", "https://api.anthropic.com/v1"),
        claude("relay", "https://relay.example.com/v1"),
        claude("official-off", "https://api.anthropic.com/v1", { promptCaching: false }),
        claude("sub", "https://api.anthropic.com/v1", { authMode: "oauth", oauth: { flow: "anthropic" } }),
        { id: "openai", type: "openai", baseUrl: "https://api.openai.com/v1" },
      ],
    }, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    const byId = (id: string) => out.providers.find((p: any) => p.id === id);
    expect(byId("official").promptCaching).toBe(true);
    expect(byId("relay").promptCaching).toBe(false);
    expect(byId("official-off").promptCaching).toBe(false);
    expect(byId("sub").promptCaching).toBe(false);
    expect(byId("sub").authMode).toBeUndefined();
    expect("promptCaching" in byId("openai")).toBe(false);
  });

  test("APP→桌面端方向不补值(桌面端照常按自己的口径读)", () => {
    const out = rewriteAvatarsInSettings({ providers: [claude("official", "https://api.anthropic.com/v1")] }, PC_AVATAR_TYPE_TO_ANDROID, "to-pc");
    expect("promptCaching" in out.providers[0]).toBe(false);
  });

  test("桌面端备份只带描述设置形状的迁移标记;恢复新备份不改用户的选择,旧备份重跑", () => {
    const previous = state;
    try {
      setState({ ...previous, files: [], generatedImages: [], appliedMigrations: ["conversations-sqlite-1.2.6", PROMPT_CACHE_OFFICIAL_DEFAULT_MIGRATION] } as never);
      const payload = backupPayloadMetadataOnly({ providers: [], assistants: [] } as never);
      expect(payload.state.appliedMigrations).toEqual([...BACKUP_CARRIED_MIGRATIONS]);
    } finally {
      setState(previous);
    }
    const userOff = [claude("official", "https://api.anthropic.com/v1", { promptCaching: false })];
    expect(find(upgradedState(userOff, [PROMPT_CACHE_OFFICIAL_DEFAULT_MIGRATION]), "official").promptCaching).toBe(false);
    expect("promptCaching" in find(upgradedState(userOff), "official")).toBe(false);
  });
});
