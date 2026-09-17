// 模型图标规则回归(内测反馈:K3 系列头像不对)。规则表按序首中,新增/调整规则时
// 这里的正反例保证既命中目标又不误伤近邻(词边界语义)。
import { describe, expect, test } from "bun:test";

import { iconForName } from "./icons";

describe("iconForName", () => {
  test("Kimi 家族:官方 id 与裸 K 系列短名都命中", () => {
    expect(iconForName("kimi-k3")).toBe("kimi-color.svg");
    expect(iconForName("kimi-k2.7-code")).toBe("kimi-color.svg");
    expect(iconForName("kimi-latest")).toBe("kimi-color.svg");
    // 裸短名(聚合商列表/手动录入常见):词边界匹配
    expect(iconForName("k3")).toBe("kimi-color.svg");
    expect(iconForName("K3")).toBe("kimi-color.svg");
    expect(iconForName("k3.5")).toBe("kimi-color.svg");
    expect(iconForName("k4-preview")).toBe("kimi-color.svg");
  });

  test("不误伤近邻:k 前是字母时无词边界", () => {
    expect(iconForName("grok-3")).toBe("grok.svg");
    expect(iconForName("grok3")).toBe("grok.svg");
    expect(iconForName("deepseek3")).toBe("deepseek-color.svg");
    expect(iconForName("deepseek-v3")).toBe("deepseek-color.svg");
  });

  test("moonshot 命中月之暗面供应商图标", () => {
    expect(iconForName("moonshot-v1-8k")).toBe("moonshot.svg");
    expect(iconForName("月之暗面")).toBe("moonshot.svg");
  });

  test("搜索服务新类型:serper/豆包/ollama/exa 图标命中(label 作图标键)", () => {
    // serper 不在 lobehub,用官方品牌标 serper.png
    expect(iconForName("Serper")).toBe("serper.png");
    // 豆包 label 是中文,需命中豆包专属图标而非 bytedance/兜底
    expect(iconForName("豆包")).toBe("doubao-color.svg");
    expect(iconForName("doubao")).toBe("doubao-color.svg");
    expect(iconForName("Ollama")).toBe("ollama.svg");
    expect(iconForName("Exa")).toBe("exa.png");
  });

  test("预置供应商新类型:MiniMax/MIMO 图标命中(label 作图标键)", () => {
    // 与 APP AIIconMatcher 对齐:MiniMax→minimax-color.svg,MIMO(小米)→xiaomimimo.svg
    expect(iconForName("MiniMax")).toBe("minimax-color.svg");
    expect(iconForName("MIMO")).toBe("xiaomimimo.svg");
  });

  test("腾讯混元新旗舰 hy3/hy4:裸小写 id 命中混元标(词边界防误伤)", () => {
    expect(iconForName("hy3")).toBe("hunyuan-color.svg");
    expect(iconForName("hy4-preview")).toBe("hunyuan-color.svg");
    expect(iconForName("hunyuan-t1")).toBe("hunyuan-color.svg");
    // 误伤面:别家带 hy 子串但无词边界的不命中混元。
    expect(iconForName("shy")).not.toBe("hunyuan-color.svg");
  });

  test("Meta 系 muse-spark/glimmer:命中 meta 标(对齐 APP PATTERN_META)", () => {
    expect(iconForName("muse-spark")).toBe("meta-color.svg");
    expect(iconForName("muse-glimmer")).toBe("meta-color.svg");
    expect(iconForName("meta-llama-3")).toBe("meta-color.svg");
  });
});
