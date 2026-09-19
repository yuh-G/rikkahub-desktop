// 专题3 批2:PC↔APP 契约清洗单元测试。
// 背景(锁死原因):安卓 JsonInstant 无 coerceInputValues——非空字段收到显式 null、密封类
// 收到未知判别符都直接抛 SerializationException;settings 恢复整体失败,会话解码
// (loadMessageNodes)零容错,一条脏消息 = 会话永久打不开。以下契约破坏任何一条,
// 用户症状都是"导入失败/会话打不开",且难以自查。
import { describe, expect, test } from "bun:test";

import { rewriteAndroidFileUrl, rewriteAndroidFileUrlsDeep } from "./file-refs";
import {
  downgradeUnknownPartForAndroid,
  filterAnnotationsForAndroid,
  filterMessagePartsForAndroid,
  filterSearchServicesForAndroid,
  filterTtsProvidersForAndroid,
  PC_AVATAR_TYPE_TO_ANDROID,
  rewriteAvatarsInSettings,
  toAndroidPresetMessage,
} from "./export";

describe("toAndroidPresetMessage(A-1 preset 形状)", () => {
  test("PC 简化形态 {role, content} 转成安卓 UIMessage 形状(parts 必填)", () => {
    expect(toAndroidPresetMessage({ role: "USER", content: "hi" })).toEqual({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  test("空 content 得到空 parts(安卓接受空列表,但缺 parts 键即炸)", () => {
    expect(toAndroidPresetMessage({ role: "ASSISTANT", content: "" })).toEqual({ role: "assistant", parts: [] });
    expect(toAndroidPresetMessage({ role: "ASSISTANT" })).toEqual({ role: "assistant", parts: [] });
  });

  test("安卓原生形态(已带 parts)只做 role 卫生,不重复包装", () => {
    const androidShape = {
      id: "0e2d2a4a-9d67-4d7e-9a5b-9c7f0a3b1c2d",
      role: "user",
      parts: [{ type: "text", text: "x" }],
      createdAt: "2026-01-01T00:00:00",
    };
    expect(toAndroidPresetMessage(androidShape)).toEqual(androidShape);
  });

  test("显式 null / 非法 uuid 的 id 与 null createdAt 删键(安卓非空字段拒 null,缺键走默认)", () => {
    const out = toAndroidPresetMessage({ id: null, role: "USER", content: "x", createdAt: null }) as any;
    expect("id" in out).toBe(false);
    expect("createdAt" in out).toBe(false);
    const out2 = toAndroidPresetMessage({ id: "not-a-uuid", role: "USER", content: "x" }) as any;
    expect("id" in out2).toBe(false);
  });

  test("缺 role 回退 user(安卓 role 必填)", () => {
    expect((toAndroidPresetMessage({ content: "x" }) as any).role).toBe("user");
  });
});

describe("filterAnnotationsForAndroid(A-2 注解过滤)", () => {
  test("PC-only 的 model_call_error 被过滤,url_citation 与未来安卓类型透传", () => {
    expect(
      filterAnnotationsForAndroid([
        { type: "model_call_error", message: "上游 500" },
        { type: "url_citation", url: "https://x", title: "t" },
        { type: "some_future_android_type", payload: 1 },
      ]),
    ).toEqual([
      { type: "url_citation", url: "https://x", title: "t" },
      { type: "some_future_android_type", payload: 1 },
    ]);
  });

  test("缺判别符的脏对象、非对象条目、非数组输入都清洗掉", () => {
    expect(filterAnnotationsForAndroid([{ junk: 1 }, null, "str", 42])).toEqual([]);
    expect(filterAnnotationsForAndroid(undefined)).toEqual([]);
    expect(filterAnnotationsForAndroid("junk")).toEqual([]);
  });
});

describe("搜索服务过滤机制(S-1)与 custom_js 事故回归", () => {
  const services = [
    { id: "a", type: "tavily", apiKey: "k" },
    { id: "b", type: "custom_js", searchScript: "return []" },
    { id: "c", type: "exa", apiKey: "k2" },
  ];

  test("⚠️ custom_js 是安卓正式类型(CustomJsOptions),导出决不能再过滤它", () => {
    // 事故回归锁:2026-07-28 曾误判 custom_js 为 PC-only 并过滤,会静默丢用户配置。
    const out = rewriteAvatarsInSettings({ searchServices: services, searchServiceSelected: 1 }, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    expect(out.searchServices.map((s: any) => s.type)).toEqual(["tavily", "custom_js", "exa"]);
    expect(out.searchServiceSelected).toBe(1);
  });

  test("机制:注入 PC-only 集时过滤并重定位选中下标(未来登记新类型时的行为契约)", () => {
    const pcOnly = new Set(["custom_js"]);
    const r1 = filterSearchServicesForAndroid(services, 2, pcOnly);
    expect(r1.services.map((s: any) => s.type)).toEqual(["tavily", "exa"]);
    expect(r1.selectedIndex).toBe(1); // 原选中 exa(下标2)→ 过滤后下标1
    const r2 = filterSearchServicesForAndroid(services, 1, pcOnly);
    expect(r2.selectedIndex).toBe(0); // 选中项恰被过滤 → 回退 0
    const r3 = filterSearchServicesForAndroid([{ id: "b", type: "custom_js" }], 0, pcOnly);
    expect(r3.services).toEqual([]); // 全滤空由调用方删键,安卓走默认
  });

  test("当前黑名单为空:任何类型都原样透传", () => {
    const out = filterSearchServicesForAndroid(services, 0);
    expect(out.services).toEqual(services);
  });
});

describe("filterMessagePartsForAndroid(A-3 loading 过滤 + C3 白名单降级)", () => {
  test("loading 占位与缺判别符脏对象被删除;安卓已知类型原样透传", () => {
    expect(
      filterMessagePartsForAndroid([
        { type: "loading", label: "生成中" },
        { type: "text", text: "hi" },
        { type: "server_tool", toolName: "web_search", status: "completed" },
        { junk: 1 },
        null,
      ]),
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "server_tool", toolName: "web_search", status: "completed" },
    ]);
  });

  test("C3:不在 vendored 安卓全集内的未知判别符被降级为占位 text part(不硬发给旧 APP)", () => {
    const out = filterMessagePartsForAndroid([
      { type: "some_future_pc_part", text: "未来内容摘要" },
      { type: "text", text: "正常" },
    ]) as any[];
    expect(out[0].type).toBe("text");
    expect(out[0].text).toContain("some_future_pc_part");
    expect(out[0].text).toContain("未来内容摘要");
    expect(out[1]).toEqual({ type: "text", text: "正常" });
  });

  test("C3 降级保留可读摘要:工具调用与附件也有提示", () => {
    expect(downgradeUnknownPartForAndroid({ type: "future_tool", toolName: "code_exec" }).text).toContain("code_exec");
    expect(downgradeUnknownPartForAndroid({ type: "future_media", url: "file:///x.png" }).text).toContain("x.png");
    expect(downgradeUnknownPartForAndroid({ type: "bare" }).text).toContain("bare");
  });

  test("preset 消息里的 loading 仍被清洗、未知 part 仍被降级(toAndroidPresetMessage 链路)", () => {
    const out = toAndroidPresetMessage({ role: "user", parts: [{ type: "loading" }, { type: "text", text: "x" }, { type: "pc_only_x" }] }) as any;
    expect(out.parts.map((p: any) => p.type)).toEqual(["text", "text"]);
    expect(out.parts[1].text).toContain("pc_only_x");
  });
});

describe("C3:TTS/ASR provider 白名单清洗(旧 APP 多态解码保护)", () => {
  test("PC 已知的 12 家 TTS 全部透传(当前两端对齐,实际不滤)", () => {
    const known = ["system", "openai", "gemini", "minimax", "qwen", "groq", "xai", "mimo", "elevenlabs", "step", "fish-audio", "volcengine"]
      .map((t) => ({ id: `id-${t}`, type: t, name: t }));
    expect(filterTtsProvidersForAndroid(known)).toHaveLength(12);
  });

  test("TTS:未来 PC 先加的类型被滤掉,且选中 id 重定位到幸存项", () => {
    const out = rewriteAvatarsInSettings({
      ttsProviders: [
        { id: "a", type: "openai", name: "A" },
        { id: "b", type: "acme_future_tts", name: "B" },
        { id: "c", type: "step", name: "C" },
      ],
      selectedTTSProviderId: "b", // 选中项被滤 → 应重定位
      asrProviders: [
        { id: "x", type: "openai_realtime", name: "X" },
        { id: "y", type: "acme_future_asr", name: "Y" },
      ],
      selectedASRProviderId: "x",
    }, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    expect(out.ttsProviders.map((p: any) => p.type)).toEqual(["openai", "step"]);
    expect(out.selectedTTSProviderId).toBe("a"); // 重定位到首个幸存项
    expect(out.asrProviders.map((p: any) => p.type)).toEqual(["openai_realtime"]);
    expect(out.selectedASRProviderId).toBe("x"); // 未被滤则保留
  });

  test("TTS/ASR 全被滤时选中 id 置空串(后续 uuidFields 兜底为随机 UUID,防拒收)", () => {
    const out = rewriteAvatarsInSettings({
      ttsProviders: [{ id: "b", type: "acme_only" }],
      selectedTTSProviderId: "b",
      asrProviders: [],
    }, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    expect(out.ttsProviders).toEqual([]);
    expect(typeof out.selectedTTSProviderId).toBe("string"); // 不留悬挂 id
  });

  test("to-pc 方向不做 TTS/ASR 清洗(APP→PC 须原样保留 mimo/step 等)", () => {
    const src = {
      ttsProviders: [{ id: "b", type: "acme_future_tts" }],
      asrProviders: [{ id: "y", type: "mimo" }, { id: "z", type: "step" }],
      selectedASRProviderId: "y",
    };
    const out = rewriteAvatarsInSettings(src, PC_AVATAR_TYPE_TO_ANDROID, "to-pc");
    expect(out.asrProviders.map((p: any) => p.type)).toEqual(["mimo", "step"]);
    expect(out.ttsProviders.map((p: any) => p.type)).toEqual(["acme_future_tts"]);
  });
});

describe("rewriteAndroidFileUrl(H-1 安卓 upload 引用改写)", () => {
  const map = new Map([
    ["avatar.png", 12],
    ["图 片.png", 34],
  ]);

  test("安卓原生 file:// URI 与裸 upload/<name> 都改写成 /api/files/<id>/content", () => {
    expect(rewriteAndroidFileUrl("file:///data/user/0/me.rerere.rikkahub/files/upload/avatar.png", map)).toBe("/api/files/12/content");
    expect(rewriteAndroidFileUrl("upload/图 片.png", map)).toBe("/api/files/34/content");
  });

  test("fileSchemeOnly:settings 场景只动 file:// 字符串,提示词普通文本不受影响", () => {
    const prose = "请把结果保存到 upload/avatar.png 目录";
    expect(rewriteAndroidFileUrl(prose, map, { fileSchemeOnly: true })).toBe(prose);
    expect(
      rewriteAndroidFileUrl("file:///data/user/0/me.rerere.rikkahub/files/upload/avatar.png", map, { fileSchemeOnly: true }),
    ).toBe("/api/files/12/content");
  });

  test("映射未命中原样透传", () => {
    const unknown = "file:///data/user/0/me.rerere.rikkahub/files/upload/missing.png";
    expect(rewriteAndroidFileUrl(unknown, map)).toBe(unknown);
  });

  test("深改写:settings 对象里的头像 URL 被改写,其他值不动", () => {
    const settings = {
      assistants: [{ avatar: { type: "url", url: "file:///data/user/0/me.rerere.rikkahub/files/upload/avatar.png" } }],
      note: "upload/avatar.png 只是文字",
      count: 3,
    };
    const out = rewriteAndroidFileUrlsDeep(settings as any, map, { fileSchemeOnly: true }) as any;
    expect(out.assistants[0].avatar.url).toBe("/api/files/12/content");
    expect(out.note).toBe("upload/avatar.png 只是文字");
    expect(out.count).toBe(3);
  });
});
