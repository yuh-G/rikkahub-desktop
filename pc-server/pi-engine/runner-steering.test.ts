// pi-engine/runner-steering.test.ts — pi 引擎 steering 轮边界行为锁
//
// 锁定(2026-09-20 用户实测 2-1 的治本):
// - onSteerBoundary 只在 pi 的 turn_end(当前 assistant 消息结束)被调用,不是定时轮询——
//   分裂时刻与 pi 排水注入时刻同点;模型仍在流式时绝不触发;
// - 边界返回的文本进下一次上游请求(注入成立),且一次吸收全部(steeringMode=all:两条
//   插话同轮进入,不按轮次逐条滴灌);
// - 注入后 runner 的返回文本切到「当前段」口径(不含第一段正文)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GenerationEvent } from "../inference-engine/events";
import type { Message } from "../foundation/types";
import { model, provider } from "../model-providers";
import { runPiGeneration } from "./runner";
import { startFakeOpenAiSse, type FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";

const PROVIDER_ID = "00000000-0000-4000-8000-00000000000a";

let server: FakeOpenAiSseServer;
let cwd: string;
/** 第一轮上游正在响应期间(beforeRespond 时刻)边界是否被调过——必须为 false。 */
let boundaryCallsDuringFirstStream = 0;
let boundaryCalls = 0;
/** 待注入的补发:第一轮响应期间"到达",边界排水一次性取走。 */
let pending: string[] = [];

beforeAll(async () => {
  server = await startFakeOpenAiSse([
    {
      content: "第一段正文",
      beforeRespond: () => {
        boundaryCallsDuringFirstStream = boundaryCalls;
        pending = ["插话一", "插话二"];
      },
    },
    { content: "第二段正文" },
  ]);
  cwd = mkdtempSync(join(tmpdir(), "pi-runner-steer-"));
});

afterAll(async () => {
  await server.close();
});

describe("pi runner steering 轮边界", () => {
  test("边界只在 turn_end 触发、整批注入下一轮请求、返回文本切当前段", async () => {
    const events: GenerationEvent[] = [];
    const ourProvider = provider({ id: PROVIDER_ID, name: "Steer Provider", baseUrl: server.baseUrl, apiKey: "sk-test" });
    const ourModel = model("fake-model", "Steer Model");
    const result = await runPiGeneration({
      provider: ourProvider,
      model: ourModel,
      conversationId: "conv-runner-steer",
      cwd,
      history: [] as Message[],
      promptText: "开始",
      sink: (event) => events.push(event),
      onSteerBoundary: () => {
        boundaryCalls += 1;
        const taken = pending;
        pending = [];
        return taken;
      },
    });

    // 第一轮流式期间(模型还在响应)边界从未被调:不是轮询。
    expect(boundaryCallsDuringFirstStream).toBe(0);
    // 两次 turn_end 各调一次(第一轮命中注入,第二轮空转),没有额外调用。
    expect(boundaryCalls).toBe(2);

    // 注入成立且一次吸收全部:第二次上游请求体里两条插话都在,且位于第一段 assistant 之后。
    expect(server.requests.length).toBe(2);
    const second = server.requests[1]! as { messages: Array<{ role: string; content: unknown }> };
    const roles = second.messages.map((m) => m.role);
    const texts = second.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    const firstAssistantIdx = texts.findIndex((t) => t.includes("第一段正文"));
    const steerOneIdx = texts.findIndex((t) => t.includes("插话一"));
    const steerTwoIdx = texts.findIndex((t) => t.includes("插话二"));
    expect(firstAssistantIdx).toBeGreaterThan(-1);
    expect(steerOneIdx).toBeGreaterThan(firstAssistantIdx);
    expect(steerTwoIdx).toBeGreaterThan(steerOneIdx);
    expect(roles[steerOneIdx]).toBe("user");
    expect(roles[steerTwoIdx]).toBe("user");

    // 返回文本 = 当前段(第二轮)口径,不再把第一段回填。
    expect(result.text).toBe("第二段正文");
    // 两段正文都经 sink 流出(第一段进 ai_1、第二段进 ai_2 由编排层落点决定,runner 无感)。
    const streamed = events.filter((e): e is Extract<GenerationEvent, { kind: "text_delta" }> => e.kind === "text_delta").map((e) => e.text).join("|");
    expect(streamed).toContain("第一段正文");
    expect(streamed).toContain("第二段正文");
  });
});
