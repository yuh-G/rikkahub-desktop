// issue4 回归网:头像引用跨端双向改写(WebDAV 备份恢复"头像丢失"的修复面,专题3 H-1)。
// 端到端(createSettingsBackupZipToPath / applyAndroidZipBackupFromPath)已用隔离数据目录
// 手工实证双向正确;涉全局 state 与真实落盘,不进单测。这里锁纯函数层:
//   PC→APP:avatar.type FQN 化 + /api/files/<id>/content 反写安卓 upload URI
//   APP→PC:FQN 回短格式 + file:///…/upload/<name> 改写 /api/files/<id>/content
import { describe, expect, test } from "bun:test";

import { rewriteAndroidFileUrlsDeep } from "./file-refs";
import {
  ANDROID_AVATAR_TYPE_TO_PC,
  PC_AVATAR_TYPE_TO_ANDROID,
  rewriteAvatarsInSettings,
  rewritePcUrlsToAndroidUpload,
} from "./export";

const IMAGE_FQN = "me.rerere.rikkahub.data.model.Avatar.Image";

describe("PC→APP:导出侧头像改写", () => {
  test("助手与用户头像:类型 FQN 化 + url 反写为安卓 upload URI", () => {
    const settings = {
      assistants: [{ id: "a1", avatar: { type: "url", url: "/api/files/7/content" } }],
      displaySetting: { userAvatar: { type: "url", url: "/api/files/7/content" } },
    };
    const typed = rewriteAvatarsInSettings(settings, PC_AVATAR_TYPE_TO_ANDROID);
    const rewritten = JSON.parse(
      rewritePcUrlsToAndroidUpload(JSON.stringify(typed), new Map([[7, "avatar.png"]])),
    );
    const expected = {
      type: IMAGE_FQN,
      url: "file:///data/user/0/me.rerere.rikkahub/files/upload/avatar.png",
    };
    expect(rewritten.assistants[0].avatar).toEqual(expected);
    expect(rewritten.displaySetting.userAvatar).toEqual(expected);
  });

  test("backupNameById 未命中的 id 原样保留(附件缺失不产出悬空 file:// 引用)", () => {
    const out = rewritePcUrlsToAndroidUpload(
      JSON.stringify({ url: "/api/files/99/content" }),
      new Map([[7, "avatar.png"]]),
    );
    expect(JSON.parse(out).url).toBe("/api/files/99/content");
  });
});

describe("APP→PC:导入侧头像改写", () => {
  test("FQN 回短格式 + file:// upload URI 改写为 /api/files/<id>/content", () => {
    const settings = {
      assistants: [{
        id: "a1",
        avatar: { type: IMAGE_FQN, url: "file:///data/user/0/me.rerere.rikkahub/files/upload/abc-123.png" },
      }],
      displaySetting: {
        userAvatar: { type: IMAGE_FQN, url: "file:///data/user/0/me.rerere.rikkahub/files/upload/abc-123.png" },
      },
    };
    const typed = rewriteAvatarsInSettings(settings, ANDROID_AVATAR_TYPE_TO_PC, "to-pc");
    const rewritten = rewriteAndroidFileUrlsDeep(
      typed,
      new Map([["abc-123.png", 3]]),
      { fileSchemeOnly: true },
    ) as typeof settings;
    const expected = { type: "url", url: "/api/files/3/content" };
    expect(rewritten.assistants[0].avatar).toEqual(expected);
    expect(rewritten.displaySetting.userAvatar).toEqual(expected);
  });

  test("fileSchemeOnly:普通文本里碰巧出现 upload/<名字> 不被误改", () => {
    const out = rewriteAndroidFileUrlsDeep(
      { systemPrompt: "see upload/abc-123.png for details" },
      new Map([["abc-123.png", 3]]),
      { fileSchemeOnly: true },
    ) as { systemPrompt: string };
    expect(out.systemPrompt).toBe("see upload/abc-123.png for details");
  });

  test("/data/data 前缀(部分 ROM 的 filesDir 直接路径)同样命中", () => {
    const out = rewriteAndroidFileUrlsDeep(
      { url: "file:///data/data/me.rerere.rikkahub/files/upload/abc-123.png" },
      new Map([["abc-123.png", 3]]),
      { fileSchemeOnly: true },
    ) as { url: string };
    expect(out.url).toBe("/api/files/3/content");
  });
});

describe("PC→APP:订阅供应商 OAuth 凭证剥离(方案 §3 决策④)", () => {
  test("to-android 剥 authMode/oauth 但保留供应商行;refresh token 不进移动端 zip", () => {
    const settings = {
      providers: [
        {
          id: "p-codex",
          name: "ChatGPT",
          authMode: "oauth",
          oauth: {
            flow: "openai-codex",
            signedInAt: 1,
            credential: { type: "oauth", access: "acc", refresh: "ref-secret", expires: 9999999999000 },
          },
        },
        { id: "p-plain", name: "OpenAI", apiKey: "sk-x" }, // 无 oauth → 不动
      ],
      chatModelId: "p-codex", // 引用仍可解析(行保留)
    };
    const out = rewriteAvatarsInSettings(settings, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    const codex = out.providers.find((p: any) => p.id === "p-codex");
    // authMode/oauth 都被剥(APP 侧表现同「未填 key」),行与其余字段保留
    expect(codex.authMode).toBeUndefined();
    expect(codex.oauth).toBeUndefined();
    expect(codex.name).toBe("ChatGPT");
    const text = JSON.stringify(out);
    expect(text).not.toContain("ref-secret");
    // 引用不悬空
    expect(out.chatModelId).toBe("p-codex");
    // 无 oauth 的供应商行原样
    expect(out.providers.find((p: any) => p.id === "p-plain")).toEqual({ id: "p-plain", name: "OpenAI", apiKey: "sk-x" });
  });

  test("to-pc 方向不剥(PC→PC 跨机恢复带上凭证,免重登,与 apiKey 同策略)", () => {
    const settings = {
      providers: [
        {
          id: "p-codex",
          authMode: "oauth",
          oauth: { flow: "openai-codex", signedInAt: 1, credential: { type: "oauth", access: "acc", refresh: "ref-secret", expires: 1 } },
        },
      ],
    };
    const out = rewriteAvatarsInSettings(settings, ANDROID_AVATAR_TYPE_TO_PC, "to-pc");
    expect(out.providers[0].oauth.credential.refresh).toBe("ref-secret");
  });
});
