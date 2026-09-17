// checks 单测:endpointFor/modelsEndpointFor URL 拼接矩阵(A:claude 归一化,与 pi
// piBaseUrlFor 同款规则)与 upstreamHttpError 报文(B:404 形态诊断)。
import { describe, expect, it } from "bun:test";

import { upstreamHttpError } from "../inference-engine/providers";
import { endpointFor } from "./checks";
import { modelsEndpointFor, provider } from "./index";

function make(input: Parameters<typeof provider>[0]) {
  return provider({ apiKey: "sk-test", ...input });
}

describe("endpointFor URL 拼接", () => {
  it("claude 归一化(A):剥尾部 /v1 拼 /v1/messages,带不带 /v1、尾斜杠、中转深路径都收敛到同一形态", () => {
    for (const baseUrl of [
      "https://api.anthropic.com/v1",
      "https://api.anthropic.com",
      "https://api.anthropic.com/v1/",
      "https://api.anthropic.com/",
    ]) {
      expect(endpointFor(make({ id: "c", name: "C", baseUrl, type: "claude" }))).toBe(
        "https://api.anthropic.com/v1/messages",
      );
    }
    // 中转深路径:claude 兼容端点同样是 /v1/messages 后缀,两种填法等价。
    for (const baseUrl of ["https://relay.example.com/claude/v1", "https://relay.example.com/claude"]) {
      expect(endpointFor(make({ id: "c", name: "C", baseUrl, type: "claude" }))).toBe(
        "https://relay.example.com/claude/v1/messages",
      );
    }
  });

  it("openai/google 拼接不受 A 影响(行为回归锁)", () => {
    expect(endpointFor(make({ id: "o", name: "O", baseUrl: "https://api.openai.com/v1" }))).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(
      endpointFor(make({ id: "o2", name: "O", baseUrl: "https://api.openai.com/v1", useResponseApi: true })),
    ).toBe("https://api.openai.com/v1/responses");
    // §2.3 responsesPath:自定义路径生效(Azure/网关非标准 Responses 端点);空白回落 /responses。
    expect(
      endpointFor(
        make({
          id: "o2c",
          name: "O",
          baseUrl: "https://my.azure.com/openai/deployments/gpt5",
          useResponseApi: true,
          responsesPath: "/responses?api-version=2025-04-01-preview",
        }),
      ),
    ).toBe("https://my.azure.com/openai/deployments/gpt5/responses?api-version=2025-04-01-preview");
    expect(
      endpointFor(make({ id: "o2d", name: "O", baseUrl: "https://api.openai.com/v1", useResponseApi: true, responsesPath: "   " })),
    ).toBe("https://api.openai.com/v1/responses");
    expect(
      endpointFor(
        make({ id: "o3", name: "O", baseUrl: "https://x.example.com", chatCompletionsPath: "/api/chat" }),
      ),
    ).toBe("https://x.example.com/api/chat");
    expect(
      endpointFor(make({ id: "g", name: "G", baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "google" })),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
  });
});

describe("modelsEndpointFor URL 拼接", () => {
  it("claude 归一化(A):剥尾部 /v1 拼 /v1/models;openai/google 不受影响", () => {
    for (const baseUrl of ["https://api.anthropic.com/v1", "https://api.anthropic.com"]) {
      expect(modelsEndpointFor(make({ id: "c", name: "C", baseUrl, type: "claude" }))).toBe(
        "https://api.anthropic.com/v1/models",
      );
    }
    expect(modelsEndpointFor(make({ id: "o", name: "O", baseUrl: "https://api.openai.com/v1" }))).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(
      modelsEndpointFor(make({ id: "g", name: "G", baseUrl: "https://generativelanguage.googleapis.com/v1beta", type: "google" })),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100");
  });
});

describe("upstreamHttpError 报文(B:404 形态诊断)", () => {
  const p = make({ id: "e", name: "Anthropic", baseUrl: "https://api.anthropic.com", type: "claude" });

  it("404:报文带最终请求 URL 与 Base URL 形态提示(正文常为 HTML/空串,URL 才是线索)", () => {
    const err = upstreamHttpError(p, "https://api.anthropic.com/messages", 404, "<html>Not Found</html>");
    expect(err.message).toContain("Anthropic 404");
    expect(err.message).toContain("https://api.anthropic.com/messages");
    expect(err.message).toContain("Base URL");
    expect(err.message).toContain("<html>Not Found</html>");
    // 空正文不产生悬空换行。
    const bare = upstreamHttpError(p, "https://x/v1/messages", 404, "");
    expect(bare.message.endsWith("\n")).toBe(false);
  });

  it("非 404:保持原样拼接(厂商正文自带解释,不加多余提示);正文截断 500 字符", () => {
    const err = upstreamHttpError(p, "https://api.anthropic.com/v1/messages", 429, "rate limited");
    expect(err.message).toBe("Anthropic 429: rate limited");
    expect(err.message).not.toContain("Base URL");
    const long = upstreamHttpError(p, "https://x", 500, "x".repeat(600));
    expect(long.message.length).toBeLessThanOrEqual("Anthropic 500: ".length + 500);
  });
});
