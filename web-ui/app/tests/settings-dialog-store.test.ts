// settings-dialog-store.test.ts — 设置模态开合、二级记忆与深链参数的来源切换。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  closeSettingsDialog,
  currentSettingsSub,
  getSettingsParam,
  openSettingsDialog,
  rememberSettingsLocation,
  setSettingsDialogSection,
  setSettingsDialogSub,
  toggleSettingsDialog,
  useSettingsDialogStore,
  withSettingsLocation,
} from "~/stores/settings-dialog-store";

const originalWindow = (globalThis as { window?: unknown }).window;

function setAddressBarSearch(search: string) {
  (globalThis as { window?: unknown }).window = { location: { search } };
}

const currentSub = () => currentSettingsSub(useSettingsDialogStore.getState());

beforeEach(() => {
  useSettingsDialogStore.setState({ open: false, section: "general", subBySection: {}, search: "" });
  setAddressBarSearch("");
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("openSettingsDialog", () => {
  test("深链带 sub 时定位到该一级与二级", () => {
    openSettingsDialog("?section=models&sub=providers&providerId=p1");
    const state = useSettingsDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.section).toBe("models");
    expect(currentSub()).toBe("providers");
    expect(state.search).toBe("?section=models&sub=providers&providerId=p1");
  });

  test("深链缺 sub 时取该一级记忆的二级", () => {
    setSettingsDialogSection("network");
    setSettingsDialogSub("port");
    setSettingsDialogSection("general");
    openSettingsDialog("?section=network");
    expect(currentSub()).toBe("port");
  });

  test("旧 id 深链落到新位置", () => {
    openSettingsDialog("?section=proxy");
    expect(useSettingsDialogStore.getState().section).toBe("network");
    expect(currentSub()).toBe("proxy");
  });

  test("无参打开回到上次停留的一级与二级,并清掉旧深链参数", () => {
    openSettingsDialog("?section=models&sub=providers&providerId=p1");
    setSettingsDialogSection("speech");
    setSettingsDialogSub("asr");
    closeSettingsDialog();
    openSettingsDialog();
    const state = useSettingsDialogStore.getState();
    expect(state.section).toBe("speech");
    expect(currentSub()).toBe("asr");
    expect(state.search).toBe("");
  });

  test("非法 section 不污染当前位置", () => {
    setSettingsDialogSection("data");
    openSettingsDialog("?section=not-a-section");
    expect(useSettingsDialogStore.getState().section).toBe("data");
    expect(currentSub()).toBe("backup");
  });

  test("toggle 开合往返", () => {
    toggleSettingsDialog();
    expect(useSettingsDialogStore.getState().open).toBe(true);
    toggleSettingsDialog();
    expect(useSettingsDialogStore.getState().open).toBe(false);
  });
});

describe("二级记忆", () => {
  test("切到别的一级再切回,恢复上次的二级", () => {
    setSettingsDialogSection("extensions");
    setSettingsDialogSub("quick");
    setSettingsDialogSection("memory");
    expect(currentSub()).toBeNull();
    setSettingsDialogSection("extensions");
    expect(currentSub()).toBe("quick");
  });

  test("没记过的一级默认第一个二级", () => {
    setSettingsDialogSection("stats");
    expect(currentSub()).toBe("usage");
  });

  test("不属于当前一级的二级不会被当成当前页", () => {
    setSettingsDialogSection("general");
    setSettingsDialogSub("tts");
    expect(currentSub()).toBe("profile");
  });

  test("整页写入与模态共用记忆,并返回补全后的二级", () => {
    expect(rememberSettingsLocation({ section: "speech", sub: "asr" })).toBe("asr");
    expect(rememberSettingsLocation({ section: "data", sub: null })).toBe("backup");
    setSettingsDialogSection("speech");
    expect(currentSub()).toBe("asr");
  });
});

describe("getSettingsParam", () => {
  test("模态打开时读模态的深链,不读地址栏", () => {
    setAddressBarSearch("?providerId=from-address-bar");
    openSettingsDialog("?section=models&sub=providers&providerId=from-dialog");
    expect(getSettingsParam("providerId")).toBe("from-dialog");
  });

  test("模态关闭时读整页路由的地址栏", () => {
    setAddressBarSearch("?section=extensions&sub=injection&tab=lorebook");
    expect(getSettingsParam("tab")).toBe("lorebook");
  });

  test("深链只用一次:主动切一级或二级后不再读到页内参数", () => {
    openSettingsDialog("?section=models&sub=providers&providerId=p1");
    setSettingsDialogSub("scenes");
    expect(getSettingsParam("providerId")).toBeNull();

    openSettingsDialog("?section=models&sub=providers&providerId=p1");
    setSettingsDialogSection("network");
    expect(getSettingsParam("providerId")).toBeNull();
  });
});

describe("withSettingsLocation", () => {
  test("改写 section/sub 且保留其余深链参数", () => {
    const params = new URLSearchParams(
      withSettingsLocation("?section=general&sub=app&providerId=p1", "models", "providers"),
    );
    expect(params.get("section")).toBe("models");
    expect(params.get("sub")).toBe("providers");
    expect(params.get("providerId")).toBe("p1");
  });

  test("无二级时去掉 sub", () => {
    const params = new URLSearchParams(withSettingsLocation("?section=general&sub=app", "memory", null));
    expect(params.get("section")).toBe("memory");
    expect(params.has("sub")).toBe(false);
  });

  test("空查询串只产出位置本身", () => {
    expect(withSettingsLocation("", "about", null)).toBe("?section=about");
    expect(withSettingsLocation("", "data", "server")).toBe("?section=data&sub=server");
  });
});
