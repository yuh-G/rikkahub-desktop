// plugin-attribution.test.tsx — 插件署名与插件界面(P6.3):工具卡署名的解析、「来自插件 X」与 D14「被插件 X 拒绝」的
// 呈现、否决跳转定位到插件开关、插件对话框卡的四种形态(含 editor)。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { openPluginVetoSwitch, readToolAttribution } from "~/components/message/parts/plugin-attribution";
import { ToolPart as ToolStepPart, PendingToolAttentionCard } from "~/components/message/parts/tool-part";
import { WorkspaceActionCard } from "~/components/message/parts/workspace-tool-part";
import { EnginePluginPanel } from "~/components/workspace/engine-plugin-panel";
import { PaneContainerProvider } from "~/components/workspace/pane-container-context";
import { TooltipProvider } from "~/components/ui/tooltip";
import i18n from "~/i18n";
import { useAppStore } from "~/stores/app-store";
import { CHAT_CONTAINER } from "~/stores/container-tabs-store";
import { useConversationStore } from "~/stores/conversation-store";
import { usePluginsViewStore } from "~/stores/plugins-view-store";
import { useSettingsDialogStore } from "~/stores/settings-dialog-store";
import type { EngineUiStateEventDto, Settings, ToolPart } from "~/types";

// 静态渲染时 zustand 读的是初始状态(服务端快照),测试数据要同时写进初始状态对象才看得到;跑完还原,不串到别的测试文件。
const restores: Array<() => void> = [];
function seed<T extends object>(store: { setState: (patch: Partial<T>) => void; getInitialState: () => T }, patch: Partial<T>) {
  const initial = store.getInitialState();
  const before = Object.fromEntries(Object.keys(patch).map((key) => [key, initial[key as keyof T]])) as Partial<T>;
  restores.push(() => Object.assign(initial, before));
  store.setState(patch);
  Object.assign(initial, patch);
}
afterAll(() => {
  for (const restore of restores.reverse()) restore();
});

const render = (element: React.ReactElement) => renderToStaticMarkup(React.createElement(TooltipProvider, null, element));

function tool(toolName: string, extra: Partial<ToolPart> = {}): ToolPart {
  return { type: "tool", toolCallId: `call-${toolName}`, toolName, input: "{}", output: [], approvalState: { type: "auto" }, ...extra };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  const records = [{ id: "pi:guard-pkg", name: "守门员" }, { id: "pi:todo-pkg", name: "待办" }];
  seed(useAppStore, { settings: { enginePlugins: records } as unknown as Settings });
});

describe("工具卡署名的解析", () => {
  test("插件工具、被否决、两者都有;形状不对一律当没有", () => {
    expect(readToolAttribution(tool("t"))).toBeNull();
    expect(readToolAttribution({ metadata: { attribution: { pluginId: "pi:todo-pkg" } } })).toEqual({ pluginId: "pi:todo-pkg" });
    expect(readToolAttribution({ metadata: { attribution: { blockedBy: { pluginId: "pi:guard-pkg", reason: " no " } } } })).toEqual({
      blockedBy: { pluginId: "pi:guard-pkg", reason: "no" },
    });
    expect(
      readToolAttribution({ metadata: { attribution: { pluginId: "pi:todo-pkg", blockedBy: { pluginId: "pi:guard-pkg" } } } }),
    ).toEqual({ pluginId: "pi:todo-pkg", blockedBy: { pluginId: "pi:guard-pkg", reason: "" } });
    for (const attribution of [null, "pi:x", [], { pluginId: "" }, { pluginId: 3 }, { blockedBy: { reason: "r" } }, { blockedBy: [] }]) {
      expect(readToolAttribution({ metadata: { attribution } })).toBeNull();
    }
  });
});

describe("工具卡上的呈现", () => {
  const vetoed = { metadata: { attribution: { blockedBy: { pluginId: "pi:guard-pkg", reason: "不许写密钥" } } } };

  test("插件工具的步骤写「来自插件 X」;否决写「被插件 X 拒绝:原因」+「插件设置」入口", () => {
    const html = render(React.createElement(ToolStepPart, { tool: tool("todo_add", { metadata: { attribution: { pluginId: "pi:todo-pkg" } } }) }));
    expect(html).toContain("来自插件 待办");
    const blocked = render(React.createElement(ToolStepPart, { tool: tool("todo_add", { output: [{ error: "Blocked" }], ...vetoed }) }));
    expect(blocked).toContain("被插件 守门员 拒绝：不许写密钥");
    expect(blocked).toContain("插件设置");
  });

  test("被否决的工作区动作卡默认展开,正文是否决行而不是引擎的原始报错", () => {
    const html = render(
      React.createElement(WorkspaceActionCard, {
        tool: tool("write", { input: JSON.stringify({ path: "a.txt", content: "x" }), output: [{ error: 'Blocked by plugin "pi:guard-pkg": 不许写密钥' }], ...vetoed }),
      }),
    );
    expect(html).toContain("被插件 守门员 拒绝：不许写密钥");
    expect(html).not.toContain("Blocked by plugin");
  });

  test("插件工具的审批卡写明来源,多一个「此会话内总是允许」;工作区会话里的 MCP 工具也有,对话模式的 MCP 工具没有(D32)", () => {
    const pending = { approvalState: { type: "pending" } as const };
    const plugin = render(
      React.createElement(PendingToolAttentionCard, {
        tool: tool("todo_add", { ...pending, metadata: { attribution: { pluginId: "pi:todo-pkg" } } }),
        onToolApproval: () => undefined,
      }),
    );
    expect(plugin).toContain("来自插件 待办");
    expect(plugin).toContain("此会话内总是允许");
    const mcpCard = (container: string) =>
      render(
        React.createElement(
          PaneContainerProvider,
          { container },
          React.createElement(PendingToolAttentionCard, { tool: tool("mcp__x__y", pending), onToolApproval: () => undefined }),
        ),
      );
    expect(mcpCard(CHAT_CONTAINER)).not.toContain("此会话内总是允许");
    expect(mcpCard("ws-1")).toContain("此会话内总是允许");
    const other = render(
      React.createElement(PaneContainerProvider, { container: "ws-1" }, React.createElement(PendingToolAttentionCard, { tool: tool("search_web", pending), onToolApproval: () => undefined })),
    );
    expect(other).not.toContain("此会话内总是允许");
  });

  test("「插件设置」跳到否决方的详情概览,并定位高级设置里的拦截开关", () => {
    openPluginVetoSwitch("pi:guard-pkg");
    const top = usePluginsViewStore.getState().stack.at(-1);
    expect(top).toEqual({ kind: "detail", pluginId: "pi:guard-pkg", tab: "overview" });
    const { open, focusTarget } = useSettingsDialogStore.getState();
    expect(open).toBe(true);
    expect(focusTarget).toMatchObject({
      page: "extensions/plugins",
      title: i18n.t("settings:plugins.hook_tool_call"),
      advanced: true,
      tab: i18n.t("settings:plugins.tab_overview"),
    });
  });
});

describe("插件对话框卡", () => {
  const ui = (dialogs: EngineUiStateEventDto["dialogs"], extra: Partial<EngineUiStateEventDto> = {}): EngineUiStateEventDto => ({
    conversationId: "c1",
    dialogs,
    statuses: [],
    widgets: [],
    working: null,
    ...extra,
  });
  const dialog = (request: EngineUiStateEventDto["dialogs"][number]["request"], source = "pi:todo-pkg") => ({
    requestId: `rq-${request.kind}`,
    source,
    request,
    startedAt: 1,
  });
  const panel = (state: EngineUiStateEventDto) => {
    seed(useConversationStore, { engineUi: state.dialogs.length || state.statuses.length || state.widgets.length || state.working !== null ? { c1: state } : {} });
    return render(React.createElement(EnginePluginPanel, { conversationId: "c1" }));
  };

  test("editor:预填内容进多行框,按钮是「保存」,带快捷键提示", () => {
    const html = panel(ui([dialog({ kind: "editor", title: "编辑提示词", prefill: "第一行\n第二行" })]));
    expect(html).toContain("<textarea");
    expect(html).toContain("第一行\n第二行");
    expect(html).toContain("保存");
    expect(html).toContain("Esc 取消");
    expect(html).toContain("来自插件 待办");
  });

  test("select / confirm / input 各自的控件;排队的对话框显示还有几个", () => {
    const html = panel(
      ui([
        dialog({ kind: "select", title: "选一个", options: ["甲", "乙"] }),
        dialog({ kind: "confirm", title: "确定?", message: "m" }),
        dialog({ kind: "input", title: "名字", placeholder: "p" }),
      ]),
    );
    expect(html).toContain('role="radio"');
    expect(html).toContain("还有 2 个");
    expect(panel(ui([dialog({ kind: "confirm", title: "确定?", message: "要继续吗" })]))).toContain("要继续吗");
    expect(panel(ui([dialog({ kind: "input", title: "名字", placeholder: "填个名字" })]))).toContain('placeholder="填个名字"');
  });

  test("认领不到来源时只写「来自插件」,不出跳转", () => {
    const html = panel(ui([dialog({ kind: "confirm", title: "确定?", message: "" }, "")]));
    expect(html).toContain("来自插件");
    expect(html).not.toContain("打开插件详情");
  });

  test("挂件与状态条目写来源;没有任何内容时不渲染", () => {
    const html = panel(
      ui([], {
        widgets: [{ source: "pi:todo-pkg", key: "w", lines: ["[x] a", "[ ] b"] }],
        statuses: [{ source: "pi:todo-pkg", key: "s", text: "2 项待办" }],
        working: "整理中",
      }),
    );
    expect(html).toContain("[x] a\n[ ] b");
    expect(html).toContain("2 项待办");
    expect(html).toContain("整理中");
    expect(panel(ui([]))).toBe("");
  });
});
