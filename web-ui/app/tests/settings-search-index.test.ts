// settings-search-index.test.ts — 设置搜索索引的完整性(全覆盖锁)与打分顺序。
//
// 全覆盖锁:扫描设置组件源码里 SettingsRow / SettingsSwitchRow / SettingsField / SettingsGroup
// 标签上的静态标题(label= / title= 的 t("…") 或字面量),每个都必须登记进索引,或在
// NOT_SEARCHABLE 里写明不进索引的理由。新增设置行忘了登记即红。表驱动渲染的行(开关表、
// 快捷键、场景模型)扫描抓不到,由索引手工登记 + 「索引不指向已删除的文案」反向检查兜底。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import enSettings from "~/locales/en-US/settings.json";
import zhSettings from "~/locales/zh-CN/settings.json";
import { SETTINGS_NAV, resolveSettingsSub, settingsSubItems } from "~/components/settings/settings-nav";
import { SETTINGS_SEARCH_INDEX, searchSettings } from "~/components/settings/settings-search-index";

const COMPONENTS = join(import.meta.dir, "..", "components");

/** 静态设置行标题里刻意不进索引的,逐条写理由。 */
const NOT_SEARCHABLE: Record<string, string> = {
  "settings:mcp.name": "世界书条目的名称字段:列表子实体字段,搜到也无法定位到某一条目",
  "settings:mcp.constant_active": "世界书条目字段(同上)",
  "settings:mcp.keywords_label": "世界书条目字段(同上)",
  "settings:mcp.scan_depth": "世界书条目字段(同上)",
  "settings:mcp.use_regex": "世界书条目字段(同上)",
  "settings:mcp.case_sensitive": "世界书条目字段(同上)",
  "settings:mcp.lorebook.desc": "世界书本身的描述:用户内容字段,不是设置项",
  "settings:mcp.entries_count": "世界书条目列表的计数标题,带动态数字",
  "settings:mcp.quick.content": "快捷消息的正文:用户内容字段",
  "settings:mcp.enabled": "模式注入高级区的「启用」:通用词,搜索无意义;详情头同名开关已可见",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => join(dir, name));
}

const SCANNED_FILES = [...sourceFiles(join(COMPONENTS, "settings")), ...sourceFiles(join(COMPONENTS, "memory"))];

/** 找到 JSX 开始标签的 `>`(跳过 {…} 表达式与字符串里的 `>`)。 */
function tagEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i;
  }
  return source.length;
}

/** 只取标签顶层的 label= / title=(嵌在 control={…} 里的按钮 title 不算)。 */
function topLevelTitle(head: string): string | null {
  let depth = 0;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      const rest = head.slice(i + 1);
      const keyed = /^(?:label|title)=\{t\("([^"]+)"/.exec(rest);
      if (keyed) return keyed[1];
      const literal = /^(?:label|title)="([^"]+)"/.exec(rest);
      if (literal) return literal[1];
    }
  }
  return null;
}

function scanStaticTitles(): Map<string, string> {
  const found = new Map<string, string>();
  const tag = /<(SettingsRow|SettingsSwitchRow|SettingsField|SettingsGroup)\b/g;
  for (const file of SCANNED_FILES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(tag)) {
      const start = match.index! + match[0].length;
      const title = topLevelTitle(source.slice(start, tagEnd(source, start)));
      if (title) found.set(title, file);
    }
  }
  return found;
}

function lookup(locale: unknown, key: string): unknown {
  const path = key.replace(/^settings:/, "").split(".");
  return path.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);
}

const zhT = (key: string) => {
  const value = lookup(zhSettings, key);
  return typeof value === "string" ? value : key;
};

describe("索引条目合法", () => {
  test("section/sub 合法:有二级的一级必须给出属于它的 sub,无二级的不给", () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const subs = settingsSubItems(entry.section);
      if (subs.length === 0) expect(entry.sub).toBeUndefined();
      else expect(resolveSettingsSub(entry.section, entry.sub)).toBe(entry.sub!);
    }
  });

  test("标题 / 同义词 / 页内标签的 key 在两份 locale 都存在", () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(Boolean(entry.titleKey) !== Boolean(entry.label)).toBe(true);
      for (const key of [entry.titleKey, entry.keywordsKey, entry.tabKey]) {
        if (!key) continue;
        expect(typeof lookup(zhSettings, key), `zh-CN 缺 ${key}`).toBe("string");
        expect(typeof lookup(enSettings, key), `en-US 缺 ${key}`).toBe("string");
      }
    }
  });

  test("同一页内不重复登记同一标题", () => {
    const seen = new Set<string>();
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const id = `${entry.section}/${entry.sub ?? ""}:${entry.titleKey ?? entry.label}:${entry.page ? "page" : "row"}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
  });

  test("每个页面都有页面级条目", () => {
    const pages = new Set(
      SETTINGS_SEARCH_INDEX.filter((entry) => entry.page).map((entry) => `${entry.section}/${entry.sub ?? ""}`),
    );
    for (const item of SETTINGS_NAV) {
      const subs = settingsSubItems(item.id);
      for (const sub of subs.length > 0 ? subs.map((s) => s.id) : [""]) {
        expect(pages.has(`${item.id}/${sub}`), `${item.id}/${sub}`).toBe(true);
      }
    }
  });
});

describe("全覆盖锁", () => {
  const scanned = scanStaticTitles();
  const indexed = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.titleKey ?? entry.label));

  test("扫描器本身有效(防止正则失效导致全绿)", () => {
    expect(scanned.size).toBeGreaterThan(80);
    expect(scanned.has("settings:proxy.mode")).toBe(true);
    expect(scanned.has("API Key")).toBe(true);
    // 嵌在 control={…} 里的按钮 title 不是设置行标题。
    expect(scanned.has("settings:models.edit_prompt")).toBe(false);
  });

  test("每个静态设置行标题都已登记或显式排除", () => {
    const missing = [...scanned.keys()].filter((title) => !indexed.has(title) && !(title in NOT_SEARCHABLE));
    expect(missing, `未登记进 settings-search-index.ts:\n${missing.join("\n")}`).toEqual([]);
  });

  test("排除表不过期、不与索引重叠", () => {
    for (const key of Object.keys(NOT_SEARCHABLE)) {
      expect(scanned.has(key), `${key} 已不在源码里,从 NOT_SEARCHABLE 删掉`).toBe(true);
      expect(indexed.has(key), `${key} 既登记又排除`).toBe(false);
    }
  });

  test("索引不指向已删除的文案(表驱动行的反向检查)", () => {
    const source = sourceFiles(COMPONENTS)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const entry of SETTINGS_SEARCH_INDEX) {
      if (entry.page) continue;
      if (entry.label) {
        expect(source.includes(`"${entry.label}"`), entry.label).toBe(true);
        continue;
      }
      const key = entry.titleKey!;
      const used =
        source.includes(`"${key}"`) ||
        // 本地工具表只登记前缀,渲染时拼 `${key}.title`;快捷键动作按 action 名拼。
        (key.endsWith(".title") && source.includes(`"${key.slice(0, -".title".length)}"`)) ||
        (key.startsWith("settings:hotkeys.actions.") && source.includes("settings:hotkeys.actions.${action}"));
      expect(used, `${key} 在组件源码中已不存在`).toBe(true);
    }
  });
});

describe("打分", () => {
  test("空查询返回空", () => {
    expect(searchSettings("", zhT)).toEqual([]);
    expect(searchSettings("   ", zhT)).toEqual([]);
  });

  test("结果按分数降序", () => {
    const results = searchSettings("代理", zhT);
    expect(results.length).toBeGreaterThan(3);
    for (let i = 1; i < results.length; i++) expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
  });

  test("标题全等 > 前缀 > 包含", () => {
    const results = searchSettings("代理", zhT);
    expect(results[0]).toMatchObject({ title: "代理", score: 4 }); // 页面「代理」
    expect(results.find((r) => r.title === "代理模式")?.score).toBe(3);
    expect(results.find((r) => r.title === "当前代理")?.score).toBe(2);
  });

  test("面包屑命中次于标题命中", () => {
    const results = searchSettings("记忆", zhT);
    const byBreadcrumb = results.find((r) => r.title === "AI 写入策略");
    expect(byBreadcrumb?.score).toBe(1);
    expect(results[0].score).toBeGreaterThan(1);
  });

  test("同义词兜底,大小写不敏感", () => {
    const results = searchSettings("vpn", zhT);
    expect(results.map((r) => r.title)).toContain("代理");
    expect(results.every((r) => r.score === 0.5)).toBe(true);
  });

  test("高级区条目带面包屑后缀;无二级的一级页面不重复面包屑", () => {
    const temperature = searchSettings("温度", zhT)[0];
    expect(temperature.title).toBe("温度");
    expect(temperature.breadcrumb).toBe("助手 · 高级设置");
    expect(searchSettings("关于", zhT)[0]).toMatchObject({ title: "关于", breadcrumb: "" });
  });
});
