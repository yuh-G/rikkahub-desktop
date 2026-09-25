// model-providers/auth/catalog.test.ts — 订阅供应商捆绑目录的形状锁。
// 关键不变量:
//   1. 数据源是 pi 内建目录的静态导出(exe 里同样可用),不是按路径读 pi 源码 JSON;
//   2. 产出与「获取模型列表」同构:UUID id(≠ modelId,findModel 全局按 id/modelId 匹配,
//      裸用 modelId 作 id 会与别家同名模型串台)、大写模态、TOOL/REASONING 能力位;
//   3. pi 目录的 reasoning/input 声明优先于宿主按名字推断;
//   4. 刷新目录保留同 modelId 的既有 id。
import { describe, expect, test } from "bun:test";
import { bundledModelsFor } from "./catalog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("bundledModelsFor", () => {
  test("Kimi Code 目录非空,形状与宿主模型同构", () => {
    const models = bundledModelsFor("kimi-coding");
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id).toMatch(UUID_RE);
      expect(m.id).not.toBe(m.modelId);
      expect(m.type).toBe("CHAT");
      expect(m.inputModalities).toContain("TEXT");
      expect(m.inputModalities.every((x) => x === x.toUpperCase())).toBe(true);
      expect(m.abilities.every((x) => x === x.toUpperCase())).toBe(true);
    }
    const k3 = models.find((m) => m.modelId === "k3");
    expect(k3?.abilities).toContain("REASONING");
    expect(k3?.abilities).toContain("TOOL");
    expect(k3?.inputModalities).toContain("IMAGE");
    // 名字里看不出推理能力,靠 pi 目录的 reasoning:true 声明补上。
    const k27 = models.find((m) => m.modelId === "kimi-for-coding");
    expect(k27?.abilities).toContain("REASONING");
  });

  test("ChatGPT(Codex)目录非空且全部标推理", () => {
    const models = bundledModelsFor("openai-codex");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.abilities.includes("REASONING"))).toBe(true);
  });

  test("刷新目录保留同 modelId 的既有 id,新模型给新 id", () => {
    const first = bundledModelsFor("kimi-coding");
    const keep = first.find((m) => m.modelId === "k3")!;
    const refreshed = bundledModelsFor("kimi-coding", [{ ...keep, id: "keep-me" }]);
    expect(refreshed.find((m) => m.modelId === "k3")?.id).toBe("keep-me");
    const other = refreshed.find((m) => m.modelId !== "k3")!;
    expect(other.id).toMatch(UUID_RE);
  });

  test("GitHub Copilot 目录非空(三家协议的模型全收录;宿主聊天引擎的协议取舍在供应商行)", () => {
    const models = bundledModelsFor("github-copilot");
    expect(models.length).toBeGreaterThan(10);
    expect(models.every((m) => m.id !== m.modelId)).toBe(true);
  });

  test("availableModelIds 白名单过滤(Copilot 企业账号可能只开部分模型);缺字段/非数组不过滤", () => {
    const all = bundledModelsFor("github-copilot");
    expect(all.length).toBeGreaterThan(1);
    const keep = all[0];
    const filtered = bundledModelsFor("github-copilot", [], { availableModelIds: [keep.modelId] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].modelId).toBe(keep.modelId);
    // 空数组 = 白名单存在但为空 → 空目录(诚实反映凭证,不假装全量)。
    expect(bundledModelsFor("github-copilot", [], { availableModelIds: [] })).toHaveLength(0);
    // 白名单外的 id 不出现;同 modelId 的既有 id 保留逻辑在过滤后仍生效。
    const partial = bundledModelsFor("github-copilot", [{ ...all[1], id: "keep-two" }], {
      availableModelIds: [all[1].modelId],
    });
    expect(partial).toHaveLength(1);
    expect(partial[0].id).toBe("keep-two");
    // 凭证没带 availableModelIds(pi 侧未写)→ 全量返回。
    expect(bundledModelsFor("github-copilot", [], null)).toHaveLength(all.length);
    expect(bundledModelsFor("github-copilot", [], { other: 1 })).toHaveLength(all.length);
  });
});
