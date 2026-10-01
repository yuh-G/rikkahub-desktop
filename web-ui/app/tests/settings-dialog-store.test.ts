// settings-dialog-store.test.ts — 设置模态开合与深链参数的来源切换。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  closeSettingsDialog,
  getSettingsParam,
  openSettingsDialog,
  setSettingsDialogSection,
  toggleSettingsDialog,
  useSettingsDialogStore,
  withSettingsSection,
} from "~/stores/settings-dialog-store";

const originalWindow = (globalThis as { window?: unknown }).window;

function setAddressBarSearch(search: string) {
  (globalThis as { window?: unknown }).window = { location: { search } };
}

beforeEach(() => {
  useSettingsDialogStore.setState({ open: false, section: "general", search: "" });
  setAddressBarSearch("");
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("openSettingsDialog", () => {
  test("深链 section 合法时定位到该分区", () => {
    openSettingsDialog("?section=providers&providerId=p1");
    const state = useSettingsDialogStore.getState();
    expect(state.open).toBe(true);
    expect(state.section).toBe("providers");
    expect(state.search).toBe("?section=providers&providerId=p1");
  });

  test("无参打开回到上次停留的分区,并清掉旧深链参数", () => {
    openSettingsDialog("?section=providers&providerId=p1");
    setSettingsDialogSection("speech");
    closeSettingsDialog();
    openSettingsDialog();
    const state = useSettingsDialogStore.getState();
    expect(state.section).toBe("speech");
    expect(state.search).toBe("");
  });

  test("非法 section 不污染当前分区", () => {
    setSettingsDialogSection("data");
    openSettingsDialog("?section=not-a-section");
    expect(useSettingsDialogStore.getState().section).toBe("data");
  });

  test("toggle 开合往返", () => {
    toggleSettingsDialog();
    expect(useSettingsDialogStore.getState().open).toBe(true);
    toggleSettingsDialog();
    expect(useSettingsDialogStore.getState().open).toBe(false);
  });
});

describe("getSettingsParam", () => {
  test("模态打开时读模态的深链,不读地址栏", () => {
    setAddressBarSearch("?providerId=from-address-bar");
    openSettingsDialog("?section=providers&providerId=from-dialog");
    expect(getSettingsParam("providerId")).toBe("from-dialog");
  });

  test("模态关闭时读整页路由的地址栏", () => {
    setAddressBarSearch("?section=mcp&tab=lorebook");
    expect(getSettingsParam("tab")).toBe("lorebook");
  });
});

describe("withSettingsSection", () => {
  test("改写 section 且保留其余深链参数", () => {
    const params = new URLSearchParams(withSettingsSection("?section=general&providerId=p1", "providers"));
    expect(params.get("section")).toBe("providers");
    expect(params.get("providerId")).toBe("p1");
  });

  test("空查询串补出 section", () => {
    expect(withSettingsSection("", "about")).toBe("?section=about");
  });
});
