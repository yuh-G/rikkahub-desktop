// provider-base-urls.test.ts — API 格式切换 base 换算的行为锁。
// 被测对象是 web-ui/app/lib/provider-base-urls.ts(纯函数零依赖,专为可测而独立成文件;
// web-ui 无测试框架,故测试住在 pc-server 侧按相对路径 import)。
// 核心锁的是两条用户可见不变量(初版切换逻辑两度踩坑,均来自用户反馈):
//   R1 往返不漂移:任何预置供应商在任意格式间反复切换,base 只在这家供应商自己的
//      地址族(出厂+登记)内打转,永不混入御三家官方地址。
//   R2 自定义不覆写:用户填过的地址(中转站/自建网关)在任何切换下一字节不动。
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_BASE_URLS,
  DEFAULT_BASE_URLS,
  PROVIDER_FORMAT_BASES,
  baseUrlForKindSwitch,
} from "../../web-ui/app/lib/provider-base-urls";

const KINDS = ["openai", "claude", "google"] as const;

// 预置供应商 id → 名称(测试报错可读)
const NAMES: Record<string, string> = {
  "a8d2d463-e8c0-41f2-b89e-f5eb8e716cce": "RikkaHub",
  "1eeea727-9ee5-4cae-93e6-6fb01a4d051e": "OpenAI",
  "b2c7e1a4-9f3d-4a6e-8c1b-5d7f9e2a3b14": "Anthropic",
  "6ab18148-c138-4394-a46f-1cd8c8ceaa6d": "Gemini",
  "ff3cde7e-0f65-43d7-8fb2-6475c99f5990": "xAI",
  "f099ad5b-ef03-446d-8e78-7e36787f780b": "DeepSeek",
  "f76cae46-069a-4334-ab8e-224e4979e58c": "阿里云百炼",
  "3dfd6f9b-f9d9-417f-80c1-ff8d77184191": "火山引擎",
  "ef5d149b-8e34-404b-818c-6ec242e5c3c5": "腾讯混元",
  "3bc40dc1-b11a-46fa-863b-6306971223be": "智谱AI开放平台",
  "d6c4d8c6-3f62-4ca9-a6f3-7ade6b15ecc3": "月之暗面",
  "f4f8870e-82d3-495b-9b64-d58e508b3b2c": "阶跃星辰",
  "e7a2b5c3-8f4d-4e6a-9b1c-3d5f7e8a2c04": "钠API",
  "d5734028-d39b-4d41-9841-fd648d65440e": "OpenRouter",
  "386e0f29-8228-4512-affe-8fd8add82d88": "Vercel AI Gateway",
  "56a94d29-c88b-41c5-8e09-38a7612d6cf8": "硅基流动",
};

// 每家供应商切换后允许出现的地址集合:出厂 + 全部登记格式。御三家供应商(出厂地址即
// 协议默认)额外放开全部协议默认——它们互切就是换用另一家官方协议服务,协议默认就是
// "自己家"在目标格式下的地址。
function allowedAddresses(id: string): Set<string> {
  const set = new Set<string>();
  const builtin = BUILTIN_BASE_URLS[id];
  if (builtin) set.add(builtin);
  for (const v of Object.values(PROVIDER_FORMAT_BASES[id] ?? {})) if (v) set.add(v);
  if (!builtin || Object.values(DEFAULT_BASE_URLS).includes(builtin)) {
    for (const v of Object.values(DEFAULT_BASE_URLS)) set.add(v);
  }
  return set;
}

describe("baseUrlForKindSwitch — R1 往返不漂移", () => {
  test("每家预置供应商,从出厂地址出发在全部格式间游走 6 轮,始终留在自家地址族", () => {
    for (const [id, name] of Object.entries(NAMES)) {
      const allowed = allowedAddresses(id);
      let current = BUILTIN_BASE_URLS[id]!;
      for (let round = 0; round < 6; round++) {
        for (const kind of KINDS) {
          current = baseUrlForKindSwitch(id, current, kind);
          if (!allowed.has(current)) {
            throw new Error(
              `${name} 切到 ${kind} 后漂移到 ${current}(允许集合: ${[...allowed].join(", ")})`,
            );
          }
        }
      }
      // 游走回到起始格式(openai)后,地址必须收敛到该格式的自家值:御三家供应商=协议默认
      // (它们互切就是换官方协议服务,终点由最后停留的格式决定);其余=登记或出厂单点。
      if ([...allowed].some((u) => Object.values(DEFAULT_BASE_URLS).includes(u) && u !== BUILTIN_BASE_URLS[id] && !Object.values(PROVIDER_FORMAT_BASES[id] ?? {}).includes(u))) {
        expect(Object.values(DEFAULT_BASE_URLS)).toContain(current);
      } else {
        expect(current).toBe(PROVIDER_FORMAT_BASES[id]?.openai ?? BUILTIN_BASE_URLS[id]!);
      }
    }
  });

  test("①类镜像直达:DeepSeek 出厂切 claude = /anthropic 镜像,切回 openai = 出厂", () => {
    const id = "f099ad5b-ef03-446d-8e78-7e36787f780b";
    expect(baseUrlForKindSwitch(id, "https://api.deepseek.com/v1", "claude")).toBe(
      "https://api.deepseek.com/anthropic",
    );
    expect(baseUrlForKindSwitch(id, "https://api.deepseek.com/anthropic", "openai")).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  test("②类同base:OpenRouter/xAI/硅基流动 切 claude 后 base 仍是自家出厂", () => {
    for (const id of [
      "d5734028-d39b-4d41-9841-fd648d65440e", // OpenRouter
      "ff3cde7e-0f65-43d7-8fb2-6475c99f5990", // xAI
      "56a94d29-c88b-41c5-8e09-38a7612d6cf8", // 硅基流动
      "386e0f29-8228-4512-affe-8fd8add82d88", // Vercel Gateway
      "e7a2b5c3-8f4d-4e6a-9b1c-3d5f7e8a2c04", // 钠API
    ]) {
      const builtin = BUILTIN_BASE_URLS[id]!;
      for (const kind of KINDS) {
        expect(baseUrlForKindSwitch(id, builtin, kind)).toBe(builtin);
      }
    }
  });

  test("旧bug污染自愈:DeepSeek base 已被覆写成 anthropic 官方地址,切 claude 直达镜像,切 openai 回家", () => {
    const id = "f099ad5b-ef03-446d-8e78-7e36787f780b";
    expect(baseUrlForKindSwitch(id, "https://api.anthropic.com/v1", "claude")).toBe(
      "https://api.deepseek.com/anthropic",
    );
    expect(baseUrlForKindSwitch(id, "https://api.anthropic.com/v1", "openai")).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  test("Gemini:原生 ↔ openai 兼容层往返", () => {
    const id = "6ab18148-c138-4394-a46f-1cd8c8ceaa6d";
    expect(baseUrlForKindSwitch(id, "https://generativelanguage.googleapis.com/v1beta", "openai")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(
      baseUrlForKindSwitch(id, "https://generativelanguage.googleapis.com/v1beta/openai", "google"),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  test("御三家互切:协议默认互换(出厂=协议默认)", () => {
    const openaiId = "1eeea727-9ee5-4cae-93e6-6fb01a4d051e";
    expect(baseUrlForKindSwitch(openaiId, DEFAULT_BASE_URLS.openai, "claude")).toBe(
      DEFAULT_BASE_URLS.claude,
    );
    expect(
      baseUrlForKindSwitch("b2c7e1a4-9f3d-4a6e-8c1b-5d7f9e2a3b14", DEFAULT_BASE_URLS.claude, "openai"),
    ).toBe(DEFAULT_BASE_URLS.openai);
  });
});

describe("baseUrlForKindSwitch — R2 自定义不覆写", () => {
  test("中转站地址在任何供应商、任何格式下都一字节不动(含尾斜杠形态保留)", () => {
    const custom = "https://my-relay.example.com/v1";
    for (const id of [...Object.keys(NAMES), "user-custom-provider"]) {
      for (const kind of KINDS) {
        expect(baseUrlForKindSwitch(id, custom, kind)).toBe(custom);
      }
    }
    expect(
      baseUrlForKindSwitch("f099ad5b-ef03-446d-8e78-7e36787f780b", "https://relay.example.com/", "google"),
    ).toBe("https://relay.example.com");
  });

  test("自定义供应商(无出厂)空地址 → 填协议默认", () => {
    for (const kind of KINDS) {
      expect(baseUrlForKindSwitch("user-custom", "", kind)).toBe(DEFAULT_BASE_URLS[kind]);
    }
  });
});
