// plugins-model.test.ts — 插件页首页的分组、筛选、排序与徽标判定(多引擎用假引擎表),来源与副信息的取值,
// 详情用到的审计对象解析、问题计数、README 图片过滤与 MCP 服务对位。
import { describe, expect, test } from "bun:test";

import {
  groupPlugins,
  isPluginFilterActive,
  joinPluginRows,
  marketInstalledRecord,
  parseAuditSubject,
  pluginDisplayName,
  pluginIssueCount,
  pluginSourceLabel,
  pluginStatuses,
  pluginSubtitle,
  recordOfView,
  registeredPluginMcpServer,
  stripRelativeImages,
  type PluginRowModel,
} from "~/components/settings/extensions/plugins/model";
import { formatMonthlyDownloads } from "~/components/settings/extensions/plugins/market-card";
import { uploadFileProblem } from "~/components/settings/extensions/plugins/upload-view";
import { DEFAULT_PLUGIN_FILTERS, type PluginHomeFilters } from "~/stores/plugins-view-store";
import type { EnginePluginRecord, EnginePluginViewDto } from "~/types/plugins";

function record(patch: Partial<EnginePluginRecord> & Pick<EnginePluginRecord, "id" | "name">): EnginePluginRecord {
  return {
    engine: "pi",
    source: { kind: "npm", spec: patch.name },
    version: "1.0.0",
    enabled: true,
    hookSwitches: { toolCall: true },
    toolSwitches: {},
    installedAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

const PI = { id: "pi", label: "Pi" };
const DSH = { id: "dsh", label: "DSH" };
const RECORDS = [
  record({ id: "pi:web", name: "pi-web-access", installedAt: "2026-11-10T00:00:00.000Z", meta: { author: "nico", description: "网页搜索与抓取" } }),
  record({ id: "pi:todo", name: "rpiv-todo", installedAt: "2026-11-12T00:00:00.000Z", enabled: false }),
  record({ id: "pi:lens", name: "Pi-Lens", installedAt: "2026-11-05T00:00:00.000Z" }),
  record({ id: "dsh:a", name: "dsh-alpha", engine: "dsh", installedAt: "2026-11-11T00:00:00.000Z" }),
];
const rows = (): PluginRowModel[] => RECORDS.map((item) => ({ record: item }));
const names = (filters: Partial<PluginHomeFilters>, engines = [PI, DSH]) =>
  groupPlugins(rows(), engines, { ...DEFAULT_PLUGIN_FILTERS, ...filters }).map((group) => [
    group.engine.id,
    group.rows.map((row) => row.record.name),
  ]);

describe("分组与排序", () => {
  test("按引擎表的顺序分组,组内默认按添加时间从新到旧", () => {
    expect(names({})).toEqual([
      ["pi", ["rpiv-todo", "pi-web-access", "Pi-Lens"]],
      ["dsh", ["dsh-alpha"]],
    ]);
    expect(names({}, [DSH, PI]).map(([id]) => id)).toEqual(["dsh", "pi"]);
  });

  test("按名称排序在各组内分别生效,不分大小写", () => {
    expect(names({ sort: "name" })).toEqual([
      ["pi", ["Pi-Lens", "pi-web-access", "rpiv-todo"]],
      ["dsh", ["dsh-alpha"]],
    ]);
  });

  test("引擎表里没有的引擎排在后面,组名用引擎 id", () => {
    const groups = groupPlugins(rows(), [PI], DEFAULT_PLUGIN_FILTERS);
    expect(groups.map((group) => group.engine)).toEqual([PI, { id: "dsh", label: "dsh" }]);
  });
});

describe("筛选", () => {
  test("展示:已启用 / 未启用;筛完为空的组不出现", () => {
    expect(names({ show: "disabled" })).toEqual([["pi", ["rpiv-todo"]]]);
    expect(names({ show: "enabled" })).toEqual([
      ["pi", ["pi-web-access", "Pi-Lens"]],
      ["dsh", ["dsh-alpha"]],
    ]);
  });

  test("引擎筛选只在引擎数 ≥ 2 时生效", () => {
    expect(names({ engine: "dsh" })).toEqual([["dsh", ["dsh-alpha"]]]);
    expect(names({ engine: "dsh" }, [PI]).map(([id]) => id)).toEqual(["pi", "dsh"]);
    expect(isPluginFilterActive({ ...DEFAULT_PLUGIN_FILTERS, engine: "dsh" }, [PI])).toBe(false);
    expect(isPluginFilterActive({ ...DEFAULT_PLUGIN_FILTERS, engine: "dsh" }, [PI, DSH])).toBe(true);
    expect(isPluginFilterActive({ ...DEFAULT_PLUGIN_FILTERS, show: "enabled" }, [PI])).toBe(true);
    expect(isPluginFilterActive({ ...DEFAULT_PLUGIN_FILTERS, query: "web" }, [PI])).toBe(false);
  });

  test("搜索按名称 / 简介 / 作者,不分大小写,首尾空白忽略", () => {
    expect(names({ query: " LENS " })).toEqual([["pi", ["Pi-Lens"]]]);
    expect(names({ query: "抓取" })).toEqual([["pi", ["pi-web-access"]]]);
    expect(names({ query: "NICO" })).toEqual([["pi", ["pi-web-access"]]]);
    expect(names({ query: "nothing" })).toEqual([]);
  });
});

describe("徽标", () => {
  const view = (patch: Partial<EnginePluginViewDto>) => ({ installed: true, loadFailed: false, auditCount: 0, ...patch });

  test("按严重程度:包不在 > 加载出错,其后是已停用、有更新;补充数据没到时只看记录", () => {
    const off = record({ id: "pi:x", name: "x", enabled: false });
    expect(pluginStatuses({ record: off })).toEqual(["disabled"]);
    expect(pluginStatuses({ record: off, view: view({ installed: false, loadFailed: true }) })).toEqual(["missing", "disabled"]);
    expect(pluginStatuses({ record: off, view: view({ loadFailed: true }), update: { latest: "2.0.0", hasUpdate: true } })).toEqual([
      "load_failed",
      "disabled",
      "update",
    ]);
  });

  test("包不在磁盘上时不提示更新(要先重装)", () => {
    const item = record({ id: "pi:x", name: "x" });
    expect(pluginStatuses({ record: item, view: view({ installed: false }), update: { latest: "2.0.0", hasUpdate: true } })).toEqual(["missing"]);
    expect(pluginStatuses({ record: item, update: { latest: "2.0.0", hasUpdate: false } })).toEqual([]);
  });

  test("joinPluginRows 按 id 对上补充数据,行序随记录", () => {
    const joined = joinPluginRows(RECORDS.slice(0, 2), [{ ...RECORDS[1]!, path: "", ...view({ loadFailed: true }) }], {
      "pi:web": { latest: "1.1.0", hasUpdate: true },
    });
    expect(joined.map((row) => [row.record.id, row.view?.loadFailed, row.update?.hasUpdate])).toEqual([
      ["pi:web", undefined, true],
      ["pi:todo", true, undefined],
    ]);
  });
});

describe("来源与副信息", () => {
  test("来源的显示:git 去掉协议与 .git,本地与上传只留文件名", () => {
    expect(pluginSourceLabel({ kind: "npm", spec: "@scope/name@1.2.3" })).toEqual({ kind: "npm", detail: "@scope/name@1.2.3" });
    expect(pluginSourceLabel({ kind: "git", spec: "git+https://github.com/o/r.git#v1" })).toEqual({ kind: "git", detail: "github.com/o/r#v1" });
    expect(pluginSourceLabel({ kind: "local", spec: "D:\\dev\\my-plugin\\" })).toEqual({ kind: "local", detail: "my-plugin" });
    expect(pluginSourceLabel({ kind: "upload", spec: "scripts/hello.ts" })).toEqual({ kind: "upload", detail: "hello.ts" });
  });

  test("副信息:作者 · 简介;缺一项只写另一项;都缺为 null", () => {
    expect(pluginSubtitle(RECORDS[0]!)).toBe("nico · 网页搜索与抓取");
    expect(pluginSubtitle(record({ id: "a", name: "a", meta: { description: "只有简介" } }))).toBe("只有简介");
    expect(pluginSubtitle(record({ id: "a", name: "a", meta: { author: " " } }))).toBeNull();
    expect(pluginSubtitle(RECORDS[1]!)).toBeNull();
  });
});

describe("详情用的取值", () => {
  test("审计对象:<类>:<名>;否决与作废只有工具名;加载失败没有对象", () => {
    expect(parseAuditSubject({ code: "pi_plugin_removed", subject: "tool:read" })).toEqual({ kind: "tool", name: "read" });
    expect(parseAuditSubject({ code: "pi_plugin_unsupported", subject: "model:openai/gpt" })).toEqual({ kind: "model", name: "openai/gpt" });
    expect(parseAuditSubject({ code: "pi_plugin_vetoed", subject: "bash" })).toEqual({ kind: "tool", name: "bash" });
    expect(parseAuditSubject({ code: "pi_plugin_load_failed", subject: "load" })).toEqual({ kind: "other", name: "" });
    expect(parseAuditSubject({ code: "pi_plugin_removed", subject: "set-model" })).toEqual({ kind: "other", name: "set-model" });
  });

  test("「有 N 项没有生效」不算按开关停用、没弹窗的否决与加载失败", () => {
    const entry = (code: string) => ({ code, subject: "tool:x", count: 1, lastAt: "" });
    expect(
      pluginIssueCount(["pi_plugin_removed", "pi_plugin_disabled", "pi_plugin_vetoed", "pi_plugin_load_failed", "pi_plugin_discarded"].map(entry)),
    ).toBe(2);
  });

  test("README 只留 https 绝对地址的图片", () => {
    const md = "a ![logo](./logo.png) b ![ok](https://x.dev/a.png) c ![http](http://x.dev/b.png) <img src=\"docs/c.png\"> <img src='https://x.dev/d.png'>";
    expect(stripRelativeImages(md)).toBe("a  b ![ok](https://x.dev/a.png) c   <img src='https://x.dev/d.png'>");
  });

  test("插件声明的 MCP 服务按插件 id + 服务名对上应用 MCP 列表里的那一台", () => {
    const servers = [
      { id: "s1", source: { kind: "plugin", pluginId: "pi:a", name: "web", active: true } },
      { id: "s2", source: { kind: "plugin", pluginId: "pi:b", name: "web", active: true } },
      { id: "s3" },
    ];
    expect(registeredPluginMcpServer(servers, "pi:b", "web")?.id).toBe("s2");
    expect(registeredPluginMcpServer(servers, "pi:a", "db")).toBeUndefined();
    expect(registeredPluginMcpServer(undefined, "pi:a", "web")).toBeUndefined();
  });

  test("插件的显示名:有记录用记录名,记录已卸载退回 id 去掉引擎前缀", () => {
    const records = [record({ id: "pi:a#2", name: "pi-todo" })];
    expect(pluginDisplayName(records, "pi:a#2")).toBe("pi-todo");
    expect(pluginDisplayName(records, "pi:@scope/gone")).toBe("@scope/gone");
    expect(pluginDisplayName(undefined, "plain")).toBe("plain");
  });

  test("接口返回的一行还原成记录:补充字段去掉", () => {
    const view = { ...RECORDS[0]!, path: "/x", installed: true, loadFailed: false, auditCount: 3 };
    expect(recordOfView(view)).toEqual(RECORDS[0]!);
  });
});

test("市场条目对已装记录:同引擎、同包名、装进安装目录的来源;本地文件夹与上传的单个脚本不算", () => {
  const records = [
    record({ id: "pi:a", name: "a", source: { kind: "local", spec: "D:/a" } }),
    record({ id: "pi:b", name: "b", source: { kind: "upload", spec: "b-1.0.0-abcdef12.tgz" } }),
    record({ id: "pi:c", name: "c", source: { kind: "upload", spec: "scripts/c.ts" } }),
    record({ id: "dsh:d", name: "d", engine: "dsh" }),
  ];
  expect(marketInstalledRecord(records, "pi", "a")).toBeUndefined();
  expect(marketInstalledRecord(records, "pi", "b")?.id).toBe("pi:b");
  expect(marketInstalledRecord(records, "pi", "c")).toBeUndefined();
  expect(marketInstalledRecord(records, "pi", "d")).toBeUndefined();
  expect(marketInstalledRecord(records, "dsh", "d")?.id).toBe("dsh:d");
});

test("月下载量用紧凑写法", () => {
  expect(formatMonthlyDownloads(995000, "zh-CN")).toBe("99.5万");
  expect(formatMonthlyDownloads(995000, "en-US")).toBe("995K");
  expect(formatMonthlyDownloads(812, "en-US")).toBe("812");
});

test("上传的前端初查:扩展名(不分大小写)、空文件、两种上限", () => {
  const mb = 1024 * 1024;
  expect(uploadFileProblem({ name: "a.TGZ", size: 10 })).toBeNull();
  expect(uploadFileProblem({ name: "a.tar.gz", size: 50 * mb })).toBeNull();
  expect(uploadFileProblem({ name: "a.gz", size: 10 })).toBe("upload_bad_type");
  expect(uploadFileProblem({ name: "a.exe", size: 10 })).toBe("upload_bad_type");
  expect(uploadFileProblem({ name: "a.zip", size: 0 })).toBe("upload_empty");
  expect(uploadFileProblem({ name: "a.zip", size: 50 * mb + 1 })).toBe("upload_too_large_archive");
  expect(uploadFileProblem({ name: "a.mjs", size: mb + 1 })).toBe("upload_too_large_script");
});
