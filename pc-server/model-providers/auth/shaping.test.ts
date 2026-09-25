// model-providers/auth/shaping.test.ts — 锁请求整形解释器(方案 §2.4)。
// 纪律:声明式整形是「标准协议之上的增删改」,各引擎调用时机(body 定稿后、customBody 前)
// 与语义(??=/合并去重)必须稳定,否则订阅供应商会以非法字段被上游 400。

import { describe, expect, test } from "bun:test";
import { applyShaping, OAUTH_PROVIDER_SHAPING, shapingFor } from "./shaping";

describe("OAUTH_PROVIDER_SHAPING 声明表", () => {
  test("五个 flow 均登记,autoEnable 全开(登录成功即启用)", () => {
    for (const flowId of ["openai-codex", "kimi-coding", "github-copilot", "xai", "anthropic"]) {
      expect(OAUTH_PROVIDER_SHAPING[flowId]?.autoEnable).toBe(true);
    }
  });

  test("Codex 走 Responses 实验通道契约头 + include 加密 reasoning + 去 max_output_tokens", () => {
    const s = OAUTH_PROVIDER_SHAPING["openai-codex"];
    expect(s.ensureHeaders?.["OpenAI-Beta"]).toBe("responses=experimental");
    expect(s.dropBodyFields).toContain("max_output_tokens");
    expect(s.mergeBody?.include).toContain("reasoning.encrypted_content");
  });
});

describe("applyShaping 解释器", () => {
  test("ensureHeaders 用 ??= 语义:用户/引擎已显式设置则不覆盖", () => {
    const headers: Record<string, string> = { originator: "custom-app" };
    applyShaping("openai-codex", headers, {});
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental"); // 未设 → 补
    expect(headers["originator"]).toBe("custom-app"); // 已设 → 不覆盖
  });

  test("dropBodyFields 删除协议层不该发的字段", () => {
    const body: Record<string, unknown> = { max_output_tokens: 4096, model: "gpt-5" };
    applyShaping("openai-codex", {}, body);
    expect("max_output_tokens" in body).toBe(false);
    expect(body.model).toBe("gpt-5"); // 其余字段不动
  });

  test("mergeBody 数组字段与已有数组合并去重(include),不覆盖", () => {
    const body: Record<string, unknown> = { include: ["reasoning.encrypted_content", "other"] };
    applyShaping("openai-codex", {}, body);
    // 已有 reasoning.encrypted_content + other,合并后去重 → 不重复、不丢 other
    expect(body.include).toEqual(["reasoning.encrypted_content", "other"]);
  });

  test("mergeBody 标量/缺省字段用 ??= 补,已有值不覆盖", () => {
    const body: Record<string, unknown> = { include: undefined };
    applyShaping("openai-codex", {}, body);
    // include 不存在(被显式置 undefined)→ ??= 补默认值
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("未登记的 flow 是空声明,headers/body 原样不动", () => {
    const headers: Record<string, string> = { Authorization: "Bearer x" };
    const body: Record<string, unknown> = { model: "m", max_output_tokens: 100 };
    applyShaping("nonexistent-flow", headers, body);
    expect(headers).toEqual({ Authorization: "Bearer x" });
    expect(body).toEqual({ model: "m", max_output_tokens: 100 });
    expect(shapingFor("nonexistent-flow")).toEqual({});
  });

  test("kimi-coding 仅 autoEnable,不改协议头(Authorization: Bearer 由凭证自身携带)", () => {
    const headers: Record<string, string> = {};
    const body: Record<string, unknown> = { model: "kimi" };
    applyShaping("kimi-coding", headers, body);
    expect(headers).toEqual({}); // 不注入任何头
    expect(body).toEqual({ model: "kimi" }); // 不动 body
  });
});
