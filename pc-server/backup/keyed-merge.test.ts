// Linux 用户实测回归网:build-from-source 全新安装导入安卓备份,"设置覆盖不完全"。
// 根因:PC 默认供应商与安卓共享同一批固定 UUID,层3 裸 mergeById(PC, APP) 同 id 无条件
// 保 PC——全新安装的无 key 出厂默认条目把手机上配好的 key/模型列表/启用状态整条挡在门外。
// 修复:mergeKeyedCollectionById,与 mergeSearchByType 同规则(APP 有 key、PC 没有 → 用 APP)。
// e2e 路径(applyAndroidZipBackupFromPath)涉全局 state 与真实落盘,项目惯例锁纯函数层。
import { describe, expect, test } from "bun:test";

import { mergeById } from "../foundation/utils";
import { mergeKeyedCollectionById, withPcEnginePluginBindings } from "./import";

const OPENAI_ID = "1eeea727-9ee5-4cae-93e6-6fb01a4d051e"; // 两端共享的默认供应商固定 UUID

describe("mergeKeyedCollectionById(七层合并·层3)", () => {
  test("全新安装场景:PC 出厂默认无 key,APP 同 id 配了 key → 整条采用 APP(key/模型/启用状态进来)", () => {
    const pc = [{ id: OPENAI_ID, name: "OpenAI", apiKey: "", enabled: false, models: [] as string[] }];
    const app = [{ id: OPENAI_ID, name: "OpenAI", apiKey: "sk-real", enabled: true, models: ["gpt-4o"] }];
    const merged = mergeKeyedCollectionById(pc, app);
    expect(merged).toHaveLength(1);
    expect(merged[0].apiKey).toBe("sk-real");
    expect(merged[0].enabled).toBe(true);
    expect(merged[0].models).toEqual(["gpt-4o"]);
  });

  test("PC 已配 key → 保 PC(层3原意:保护 PC 端已验证的 key 与定义)", () => {
    const pc = [{ id: OPENAI_ID, apiKey: "sk-pc", baseUrl: "https://pc-proxy.example/v1" }];
    const app = [{ id: OPENAI_ID, apiKey: "sk-app", baseUrl: "https://api.openai.com/v1" }];
    const merged = mergeKeyedCollectionById(pc, app);
    expect(merged).toHaveLength(1);
    expect(merged[0].apiKey).toBe("sk-pc");
    expect(merged[0].baseUrl).toBe("https://pc-proxy.example/v1");
  });

  test("两端都无 key(系统 TTS 类)→ 保 PC,安卓端本机化配置不串台", () => {
    const pc = [{ id: "sys-tts", apiKey: "", voice: "pc-voice" }];
    const app = [{ id: "sys-tts", apiKey: "", voice: "android-voice" }];
    const merged = mergeKeyedCollectionById(pc, app);
    expect(merged[0].voice).toBe("pc-voice");
  });

  test("APP 独有条目追加;PC 段顺序保持在前(searchServiceSelected 下标语义依赖)", () => {
    const pc = [
      { id: "a", apiKey: "ka" },
      { id: "b", apiKey: "" },
    ];
    const app = [
      { id: "c", apiKey: "kc" },
      { id: "b", apiKey: "kb" },
    ];
    const merged = mergeKeyedCollectionById(pc, app);
    expect(merged.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(merged[1].apiKey).toBe("kb"); // b:PC 无 key、APP 有 → 采用 APP
  });

  test("空白 key(空格)视同未配置", () => {
    const pc = [{ id: "x", apiKey: "   " }];
    const app = [{ id: "x", apiKey: "sk" }];
    expect(mergeKeyedCollectionById(pc, app)[0].apiKey).toBe("sk");
  });

  test("APP 条目缺 apiKey 字段不炸,保 PC", () => {
    const pc = [{ id: "x", apiKey: "sk-pc" }];
    const app = [{ id: "x" } as { id: string; apiKey?: string }];
    expect(mergeKeyedCollectionById(pc, app)[0].apiKey).toBe("sk-pc");
  });
});

describe("助手合并后还原桌面端的引擎插件绑定", () => {
  test("同 id 取 APP 条目时绑定按 id 放回;桌面端独有的助手原样保留;APP 独有的助手不带绑定", () => {
    const pc = [
      { id: "shared", name: "PC 名", enginePluginIds: ["pi:todo"] },
      { id: "pc-only", name: "桌面端助手", enginePluginIds: ["pi:guard"] },
    ];
    const app = [
      { id: "shared", name: "APP 名" },
      { id: "app-only", name: "手机端助手" },
    ];
    const merged = withPcEnginePluginBindings(mergeById(app as any[], pc), pc);
    expect(merged).toEqual([
      { id: "shared", name: "APP 名", enginePluginIds: ["pi:todo"] },
      { id: "app-only", name: "手机端助手" },
      { id: "pc-only", name: "桌面端助手", enginePluginIds: ["pi:guard"] },
    ]);
  });
});
