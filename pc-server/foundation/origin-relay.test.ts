// foundation/origin-relay.test.ts — origin 接力纯逻辑:决策规则表 / 记录校验 / 页面构造与
// 注入安全 / 白名单契约(键必须真实存在于 web-ui 源码,敏感键绝不入单)。
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  LEGACY_DEFAULT_PORT,
  LEGACY_RELAY_KEYS,
  ORIGIN_RELAY_KEYS,
  RELAY_POST_PATH,
  RELAY_QUERY_KEY,
  RELAY_SCRIPT_ID,
  buildLandingInjection,
  buildRelayPageScript,
  filterRelayEntries,
  inferPreV4UiOrigin,
  parseUiOriginRecord,
  planOriginRelay,
  serializeUiOriginRecord,
} from "./origin-relay";

const CURRENT = "http://localhost:17455";
const BASE = {
  recordedOrigin: "http://localhost:8080",
  currentOrigin: CURRENT,
  uiConsumer: true,
  loopbackIntent: true,
  inContainer: false,
  hadStateBeforeBoot: true,
  peekedPreferredPort: null as number | null,
};

describe("planOriginRelay 决策规则表", () => {
  test("记录的旧 origin ≠ 当前 → relay", () => {
    expect(planOriginRelay(BASE)).toEqual({ kind: "relay", fromOrigin: "http://localhost:8080" });
  });

  test("规则1:无界面消费者 / 非回环绑定 / 容器 → none", () => {
    expect(planOriginRelay({ ...BASE, uiConsumer: false })).toEqual({ kind: "none" });
    expect(planOriginRelay({ ...BASE, loopbackIntent: false })).toEqual({ kind: "none" });
    expect(planOriginRelay({ ...BASE, inContainer: true })).toEqual({ kind: "none" });
  });

  test("规则3:旧 origin 与当前相同(日常启动)→ none,且经规范化比较", () => {
    expect(planOriginRelay({ ...BASE, recordedOrigin: CURRENT })).toEqual({ kind: "none" });
    // 尾斜杠/大小写是手改记录的常见形态,规范化后同源即不接力
    expect(planOriginRelay({ ...BASE, recordedOrigin: `${CURRENT}/` })).toEqual({ kind: "none" });
    expect(planOriginRelay({ ...BASE, recordedOrigin: "HTTP://LOCALHOST:8080" })).toEqual({
      kind: "relay",
      fromOrigin: "http://localhost:8080",
    });
  });

  test("规则4:记录的主机非回环 / 非 http → none(防御:绝不向外部地址挂监听)", () => {
    expect(planOriginRelay({ ...BASE, recordedOrigin: "http://example.com:8080" })).toEqual({ kind: "none" });
    expect(planOriginRelay({ ...BASE, recordedOrigin: "https://localhost:8080" })).toEqual({ kind: "none" });
  });

  test("记录值非法(手改坏)→ none:记录在场但不可信,不退回推断去猜", () => {
    expect(planOriginRelay({ ...BASE, recordedOrigin: "not a url" })).toEqual({ kind: "none" });
  });
});

describe("[LEGACY-MIGRATION: pre-v4-ui-origin] 无记录时的旧版推断", () => {
  test("全新安装(无记录无 state)→ none", () => {
    expect(planOriginRelay({ ...BASE, recordedOrigin: null, hadStateBeforeBoot: false })).toEqual({ kind: "none" });
  });

  test("老用户升级:无记录有 state → 推断手设端口,未手设则旧默认 8080", () => {
    expect(planOriginRelay({ ...BASE, recordedOrigin: null })).toEqual({
      kind: "relay",
      fromOrigin: `http://localhost:${LEGACY_DEFAULT_PORT}`,
    });
    expect(planOriginRelay({ ...BASE, recordedOrigin: null, peekedPreferredPort: 9000 })).toEqual({
      kind: "relay",
      fromOrigin: "http://localhost:9000",
    });
    // 推断出与当前相同(手设端口=当前端口)→ none
    expect(
      planOriginRelay({ ...BASE, recordedOrigin: null, peekedPreferredPort: 17455 }),
    ).toEqual({ kind: "none" });
  });

  test("inferPreV4UiOrigin 单元行为", () => {
    expect(inferPreV4UiOrigin({ hadStateBeforeBoot: false, peekedPreferredPort: 9000 })).toBeNull();
    expect(inferPreV4UiOrigin({ hadStateBeforeBoot: true, peekedPreferredPort: null })).toBe(
      `http://localhost:${LEGACY_DEFAULT_PORT}`,
    );
    expect(inferPreV4UiOrigin({ hadStateBeforeBoot: true, peekedPreferredPort: 9000 })).toBe("http://localhost:9000");
  });
});

describe("记录文件形状", () => {
  test("serialize → parse 往返", () => {
    const raw = serializeUiOriginRecord("http://localhost:17455", 123);
    expect(parseUiOriginRecord(raw)).toEqual({ v: 1, origin: "http://localhost:17455", updatedAt: 123 });
  });

  test("空/损坏/字段非法/origin 不可解析 → null,绝不抛", () => {
    expect(parseUiOriginRecord(null)).toBeNull();
    expect(parseUiOriginRecord("")).toBeNull();
    expect(parseUiOriginRecord("{broken")).toBeNull();
    expect(parseUiOriginRecord('{"v":2,"origin":"http://localhost:1","updatedAt":1}')).toBeNull();
    expect(parseUiOriginRecord('{"v":1,"origin":123,"updatedAt":1}')).toBeNull();
    expect(parseUiOriginRecord('{"v":1,"origin":"not a url","updatedAt":1}')).toBeNull();
    expect(parseUiOriginRecord('{"v":1,"origin":"http://localhost:1","updatedAt":"x"}')).toBeNull();
  });
});

describe("页面构造与注入安全", () => {
  test("接力页脚本:旗标、目标、nonce、白名单、端点、查询键、兜底跳转齐全", () => {
    const script = buildRelayPageScript({ to: "http://localhost:17455/settings", nonce: "n-123", keys: ["a", "b"] });
    expect(script).toContain("window.__RIKKAHUB_RELAY__=1");
    expect(script).toContain('"http://localhost:17455/settings"');
    expect(script).toContain('"n-123"');
    expect(script).toContain('["a","b"]');
    expect(script).toContain(`fetch("${RELAY_POST_PATH}"`);
    expect(script).toContain(`"${RELAY_QUERY_KEY}="+n`);
    // 失败兜底:不带凭证直达新 origin
    expect(script).toContain("go(false)");
    expect(script).toContain("1500");
  });

  test("落地数据块:< 被转义,</script> 无法截断;元素 id 正确", () => {
    const injection = buildLandingInjection({
      "rikkahub.container-tabs.v2": '</script><script>alert(1)</script>',
    });
    expect(injection).toContain(`id="${RELAY_SCRIPT_ID}"`);
    expect(injection).not.toContain("</script><script>alert(1)</script>");
    expect(injection).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
  });

  test("filterRelayEntries:白名单过滤 + 非字符串丢弃 + 防御性输入", () => {
    const allowed = ["ok-key", "another"];
    expect(filterRelayEntries({ "ok-key": "v", evil: "x", "another": 5, __proto__: "y" }, allowed)).toEqual({ "ok-key": "v" });
    expect(filterRelayEntries(null, allowed)).toEqual({});
    expect(filterRelayEntries("str", allowed)).toEqual({});
    expect(filterRelayEntries([1, 2], allowed)).toEqual({});
  });
});

// ─── 白名单契约 ────────────────────────────────────────────────────────────────

const webUiAppDir = resolve(import.meta.dir, "..", "..", "web-ui", "app");

function collectWebUiSources(): string {
  let acc = "";
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) acc += readFileSync(full, "utf8");
    }
  };
  walk(webUiAppDir);
  return acc;
}

describe("白名单契约(单一来源两侧同步)", () => {
  test("ORIGIN_RELAY_KEYS 每个键都以字符串字面量存在于 web-ui 源码", () => {
    const haystack = collectWebUiSources();
    for (const key of ORIGIN_RELAY_KEYS) {
      expect(haystack.includes(`"${key}"`)).toBe(true);
    }
  });

  test("敏感镜像键(设置镜像含 API Key)绝不入单", () => {
    const all = [...ORIGIN_RELAY_KEYS, ...LEGACY_RELAY_KEYS];
    for (const banned of [
      "rikkahub.settings.mirror.v1",
      "rikkahub.conversation-list.mirror.v1",
      "rikkahub.schema-status.mirror.v1",
    ]) {
      expect(all.includes(banned)).toBe(false);
    }
  });

  test("[LEGACY-MIGRATION: pre-v4-ui-origin] 旧主题键族与 theme-provider 的 storageKey/后缀常量同步", () => {
    const themeProvider = readFileSync(join(webUiAppDir, "components", "theme-provider.tsx"), "utf8");
    const defaultKey = /storageKey\s*=\s*"([^"]+)"/.exec(themeProvider)?.[1];
    const suffix = (name: string) => new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`).exec(themeProvider)?.[1];
    const color = suffix("COLOR_THEME_STORAGE_SUFFIX");
    const user = suffix("USER_THEMES_STORAGE_SUFFIX");
    const light = suffix("LEGACY_CUSTOM_LIGHT_SUFFIX");
    const dark = suffix("LEGACY_CUSTOM_DARK_SUFFIX");
    expect(defaultKey).toBe("vite-ui-theme");
    expect([color, user, light, dark].every(Boolean)).toBe(true);
    // 键族在源码里是 storageKey+后缀 拼出来的,没有整串字面量——契约改为锁拼装结果一致
    expect(LEGACY_RELAY_KEYS.includes(defaultKey!)).toBe(true);
    expect(LEGACY_RELAY_KEYS.includes(defaultKey! + color!)).toBe(true);
    expect(LEGACY_RELAY_KEYS.includes(defaultKey! + user!)).toBe(true);
    expect(LEGACY_RELAY_KEYS.includes(defaultKey! + light!)).toBe(true);
    expect(LEGACY_RELAY_KEYS.includes(defaultKey! + dark!)).toBe(true);
    const i18n = readFileSync(join(webUiAppDir, "i18n.ts"), "utf8");
    expect(i18n.includes('getItem("lang")')).toBe(true);
    expect(LEGACY_RELAY_KEYS.includes("lang")).toBe(true);
  });
});
