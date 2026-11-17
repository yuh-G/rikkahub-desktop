// assistants/extension-selection.test.ts — 拓展选择的读取与 MCP 两条联动规则(助手弹窗、会话选择器、服务端接口共用)。
import { describe, expect, test } from "bun:test";

import { readSelectionPatch, selectionOf, withMcpServerSelected, withMcpToolOverride } from "./extension-selection";

const servers = [
  {
    id: "s1",
    commonOptions: {
      enable: true,
      tools: [
        { name: "a", enable: true },
        { name: "b", enable: true },
        { name: "hidden", enable: false },
      ],
    },
  },
  { id: "empty", commonOptions: { enable: true, tools: [] } },
];

describe("readSelectionPatch / selectionOf", () => {
  test("只读出形状合法的键,id 列表去重去空", () => {
    expect(readSelectionPatch({ mcpServers: ["s1", "s1", "", 3], enabledSkills: "x", lorebookIds: [] })).toEqual({
      mcpServers: ["s1"],
      lorebookIds: [],
    });
    expect(readSelectionPatch(null)).toEqual({});
  });

  test("逐工具覆盖只留布尔项,空的服务器与工具整项丢掉", () => {
    expect(
      readSelectionPatch({ mcpToolOverrides: { s1: { a: { enable: false, x: 1 }, b: { enable: "no" } }, s2: {} } }).mcpToolOverrides,
    ).toEqual({ s1: { a: { enable: false } } });
  });

  test("缺字段的助手按空选择", () => {
    expect(selectionOf({ id: "x" })).toEqual({
      mcpServers: [],
      mcpToolOverrides: {},
      enabledSkills: [],
      enginePluginIds: [],
      modeInjectionIds: [],
      lorebookIds: [],
      quickMessageIds: [],
    });
  });
});

describe("withMcpServerSelected", () => {
  test("重开时可见工具全被关着 → 清掉 enable 覆盖,needsApproval 保留", () => {
    const next = withMcpServerSelected(
      { mcpServers: [], mcpToolOverrides: { s1: { a: { enable: false, needsApproval: true }, b: { enable: false } } } },
      "s1",
      true,
      servers,
    );
    expect(next).toEqual({ mcpServers: ["s1"], mcpToolOverrides: { s1: { a: { needsApproval: true } } } });
  });

  test("还留着「要哪几个」时重开不动覆盖", () => {
    const overrides = { s1: { a: { enable: false } } };
    expect(withMcpServerSelected({ mcpServers: [], mcpToolOverrides: overrides }, "s1", true, servers).mcpToolOverrides).toBe(overrides);
  });

  test("已经开着的再开不触发复活;关掉只移出列表", () => {
    const overrides = { s1: { a: { enable: false }, b: { enable: false } } };
    expect(withMcpServerSelected({ mcpServers: ["s1"], mcpToolOverrides: overrides }, "s1", true, servers).mcpToolOverrides).toBe(overrides);
    expect(withMcpServerSelected({ mcpServers: ["s1"], mcpToolOverrides: overrides }, "s1", false, servers)).toEqual({
      mcpServers: [],
      mcpToolOverrides: overrides,
    });
  });
});

describe("withMcpToolOverride", () => {
  test("关掉最后一个可见工具 → 总开关跟着关(全局隐藏的工具不算)", () => {
    const first = withMcpToolOverride({ mcpServers: ["s1"], mcpToolOverrides: {} }, "s1", "a", { enable: false }, servers);
    expect(first.mcpServers).toEqual(["s1"]);
    const second = withMcpToolOverride(first, "s1", "b", { enable: false }, servers);
    expect(second).toEqual({ mcpServers: [], mcpToolOverrides: { s1: { a: { enable: false }, b: { enable: false } } } });
  });

  test("null 清掉单项,清空后服务器键也去掉", () => {
    const next = withMcpToolOverride(
      { mcpServers: ["s1"], mcpToolOverrides: { s1: { a: { enable: false } } } },
      "s1",
      "a",
      { enable: null },
      servers,
    );
    expect(next).toEqual({ mcpServers: ["s1"], mcpToolOverrides: {} });
  });

  test("needsApproval 与 enable 互不影响", () => {
    const next = withMcpToolOverride({ mcpServers: ["s1"], mcpToolOverrides: { s1: { a: { enable: false } } } }, "s1", "a", { needsApproval: true }, servers);
    expect(next.mcpToolOverrides).toEqual({ s1: { a: { enable: false, needsApproval: true } } });
  });

  test("没有可见工具的服务器不会被自动关", () => {
    expect(withMcpToolOverride({ mcpServers: ["empty"], mcpToolOverrides: {} }, "empty", "x", { enable: false }, servers).mcpServers).toEqual([
      "empty",
    ]);
  });
});
