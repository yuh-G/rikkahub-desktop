// media/image-gen.test.ts — 生图请求体判定层行为锁(对齐 Android 4e4bfa62/85af5b91)。
// 锁三件事:
//  ① isGrokImageHost:host 解析后精确匹配 x.ai 及子域——"xxx-max.ai" 中转域名
//     不误判(安卓旧版 contains("x.ai") 的回归);模型名含 grok 同样命中(#1602)。
//  ② wantsImageSize:空串/"auto" 不写入请求体,具体分辨率原样透传(#1978)。
//  ③ openRouterImageEditBody:OpenRouter 无 /images/edits,编辑参考图以
//     input_references data-URL 传入 /images/generations(#1993)——形状逐字节对齐
//     安卓 editImageWithInputReferences,含 size 省略判定与多参考图顺序。

import { describe, expect, test } from "bun:test";
import { isGrokImageHost, isOpenRouterImageHost, openRouterImageEditBody, wantsImageSize } from "./image-gen";

describe("isGrokImageHost(解析 host,不认子串)", () => {
  test("x.ai 本体与子域命中", () => {
    expect(isGrokImageHost("https://api.x.ai/v1", "gpt-image-2")).toBe(true);
    expect(isGrokImageHost("https://image.x.ai/v1", "gpt-image-2")).toBe(true);
  });

  test("中转域名含 x.ai 子串不误判(4e4bfa62 回归锁)", () => {
    expect(isGrokImageHost("https://xxx-max.ai/v1", "gpt-image-2")).toBe(false);
    expect(isGrokImageHost("https://api.example.com/x.ai/v1", "gpt-image-2")).toBe(false);
  });

  test("模型名含 grok 时任意 host 命中(#1602)", () => {
    expect(isGrokImageHost("https://openrouter.ai/api/v1", "x-ai/grok-4-image")).toBe(true);
  });

  test("非法 baseUrl 解析失败不抛错,只看模型名兜底", () => {
    expect(isGrokImageHost("not-a-url", "gpt-image-2")).toBe(false);
    expect(isGrokImageHost("not-a-url", "grok-image")).toBe(true);
  });
});

describe("wantsImageSize(size 省略判定)", () => {
  test("具体分辨率透传", () => {
    expect(wantsImageSize("1024x1024")).toBe(true);
    expect(wantsImageSize(" 1536x1024 ")).toBe(true);
  });

  test("auto 与空串省略(服务端默认尺寸)", () => {
    expect(wantsImageSize("auto")).toBe(false);
    expect(wantsImageSize("AUTO")).toBe(false);
    expect(wantsImageSize("")).toBe(false);
    expect(wantsImageSize("  ")).toBe(false);
  });
});

describe("isOpenRouterImageHost", () => {
  test("openrouter.ai 本体命中,子域与其他 host 不命中", () => {
    expect(isOpenRouterImageHost("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterImageHost("https://api.openai.com/v1")).toBe(false);
    expect(isOpenRouterImageHost("https://openrouter.ai.evil.com/v1")).toBe(false);
  });
});

describe("openRouterImageEditBody(input_references 形状,#1993)", () => {
  const pngBytes = Buffer.from([1, 2, 3]);

  test("参考图转 data-URL,字段齐整", () => {
    const body = openRouterImageEditBody({
      modelId: "bytedance-seed/seedream-4.5",
      prompt: "make it watercolor",
      count: 1,
      size: "2048x2048",
      references: [{ data: pngBytes, mime: "image/png" }],
    });
    expect(body.model).toBe("bytedance-seed/seedream-4.5");
    expect(body.prompt).toBe("make it watercolor");
    expect(body.n).toBe(1);
    expect(body.size).toBe("2048x2048");
    expect(body.input_references).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ]);
  });

  test("size 为 auto 时不写入请求体", () => {
    const body = openRouterImageEditBody({
      modelId: "google/gemini-2.5-flash-image",
      prompt: "p",
      count: 2,
      size: "auto",
      references: [{ data: pngBytes, mime: "image/png" }],
    });
    expect(body.size).toBeUndefined();
    expect(body.n).toBe(2);
  });

  test("多张参考图按传入顺序排列,mime 缺省回退 png", () => {
    const body = openRouterImageEditBody({
      modelId: "m",
      prompt: "p",
      count: 1,
      size: "1024x1024",
      references: [
        { data: pngBytes, mime: "image/jpeg" },
        { data: Buffer.from([9]), mime: "" },
      ],
    });
    expect(body.input_references).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AQID" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,CQ==" } },
    ]);
  });
});
