// api/keybindings-reset.test.ts — 「全部恢复默认」的范围锁:快捷键与 Enter 发送同页,
// reset 必须一次把两者都恢复为默认,且不碰 displaySetting 里的其它字段。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-keybindings-reset-test-"));

import { defaultSettings } from "../app-config/defaults";
import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

beforeAll(() => {
  const defaults = defaultSettings();
  setState({
    settings: {
      ...defaults,
      keybindings: { ...defaults.keybindings, newConversation: { keys: ["Ctrl", "Shift", "Y"], enabled: false } },
      displaySetting: { ...defaults.displaySetting, sendOnEnter: false, showUserAvatar: false },
    },
  } as unknown as State);
});

describe("settings/keybindings/reset", () => {
  test("快捷键与 Enter 发送回到默认,其它显示字段保持", async () => {
    const url = new URL("http://127.0.0.1/api/settings/keybindings/reset");
    const res = await handleSettingsRoutes(new Request(url, { method: "POST" }), url, "settings/keybindings/reset");
    expect(res?.status).toBe(200);
    const defaults = defaultSettings();
    expect(state.settings.keybindings).toEqual(defaults.keybindings);
    expect(state.settings.displaySetting.sendOnEnter).toBe(defaults.displaySetting.sendOnEnter);
    expect(state.settings.displaySetting.showUserAvatar).toBe(false);
  });
});
