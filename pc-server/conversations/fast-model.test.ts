// conversations/auxiliary — 默认模型未配置行为矩阵锁。
//
// 背景(用户实测):未设置快速模型时,每轮对话结束都弹两条失败提示(标题生成失败/建议
// 生成失败)。根因是 modelExists 把 AUTO 哨兵(fastModelId 的出厂默认值)当"已配置"放行,
// 辅助任务于是照常发请求,而 findModel 对哨兵 id 查不到 → 兜底第一个供应商 + 猜
// "auto"→gpt-4o-mini,对不提供该模型的服务商必 400。
//
// 六项默认模型的未配置档位(用户拍板,逐一锁定):
//   快速模型   = 静默档(null → 调用方跳过;标题退首条消息文本、建议不生成);
//   翻译/压缩  = 兜底档(回退 conversationModelIdFor,调用点内联);
//   提示词优化 = 兜底档(system.ts 端点,带会话 id 回退);
//   OCR       = 报错档(requireOcrModelId 抛人话错误);
//   图像生成   = 报错档(image-gen.ts 入口拦截,不在本文件)。
// 手动「重新生成标题」端点是快速模型的例外(用户显式点按钮),回退会话模型 —— 故
// conversationModelIdFor 仍是导出的公共口径。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-fastmodel-test-"));

import type { Conversation, State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { conversationModelIdFor, modelExists, requireOcrModelId, resolveFastModelId } from "./auxiliary";
import { DEFAULT_AUTO_MODEL_ID } from "../model-providers";

const CONVERSATION = { id: "c1", assistantId: "a1" } as unknown as Conversation;

beforeAll(() => {
  setState({
    settings: {
      assistantId: "a1",
      // 助手不覆盖模型 → 会话生效模型 = 全局 chatModelId。
      assistants: [{ id: "a1", chatModelId: null }],
      chatModelId: "chat-model-uuid",
      fastModelId: DEFAULT_AUTO_MODEL_ID,
      providers: [
        {
          id: "p1",
          type: "openai",
          baseUrl: "http://127.0.0.1:0",
          models: [{ id: "chat-model-uuid", modelId: "gpt-x" }, { id: "fast-model-uuid", modelId: "gpt-mini" }],
        },
      ],
    },
  } as unknown as State);
});

describe("modelExists:AUTO 哨兵不算已配置", () => {
  test("哨兵与空值一律否", () => {
    expect(modelExists(DEFAULT_AUTO_MODEL_ID)).toBe(false);
    expect(modelExists("")).toBe(false);
    expect(modelExists(null)).toBe(false);
    expect(modelExists(undefined)).toBe(false);
  });

  test("真实配置的模型认(id 与 modelId 两种键都认)", () => {
    expect(modelExists("chat-model-uuid")).toBe(true);
    expect(modelExists("gpt-mini")).toBe(true);
  });

  test("不存在的 id 否(删模型后设置里的残留)", () => {
    expect(modelExists("deleted-model-uuid")).toBe(false);
  });
});

describe("resolveFastModelId:没配就是 null(调用方静默跳过)", () => {
  test("从未设置(AUTO 哨兵)→ null,不猜模型不报错", () => {
    state.settings.fastModelId = DEFAULT_AUTO_MODEL_ID;
    expect(resolveFastModelId()).toBeNull();
  });

  test("设置页选「未设置」(空串)→ null", () => {
    state.settings.fastModelId = "";
    expect(resolveFastModelId()).toBeNull();
  });

  test("配了真实模型 → 用它", () => {
    state.settings.fastModelId = "fast-model-uuid";
    expect(resolveFastModelId()).toBe("fast-model-uuid");
  });

  test("配过但模型已被删除 → null(残留 id 不该让它去猜)", () => {
    state.settings.fastModelId = "deleted-model-uuid";
    expect(resolveFastModelId()).toBeNull();
  });
});

describe("conversationModelIdFor:手动重新生成标题的回退口径", () => {
  test("助手不覆盖 → 全局 chatModelId", () => {
    state.settings.assistants = [{ id: "a1", chatModelId: null }] as never;
    expect(conversationModelIdFor(CONVERSATION)).toBe("chat-model-uuid");
  });

  test("助手覆盖 → 取助手的模型", () => {
    state.settings.assistants = [{ id: "a1", chatModelId: "fast-model-uuid" }] as never;
    expect(conversationModelIdFor(CONVERSATION)).toBe("fast-model-uuid");
    state.settings.assistants = [{ id: "a1", chatModelId: null }] as never;
  });
});

// ── 六项默认模型未配置行为矩阵(用户拍板档位)─────────────────────────
//   兜底档(翻译/压缩/提示词优化):modelExists 判否 → conversationModelIdFor 回退。
//     翻译/压缩在调用点内联三元的形态,此处锁公共口径;优化在 system.ts 端点。
//   静默档(快速模型):null,见上。
//   报错档(OCR):requireOcrModelId 没配就抛人话错误,不许静默 ""。
//     (图像生成同为报错档,在 media/image-gen.ts,锁在其调用侧。)
describe("requireOcrModelId:报错档(没配就抛,不静默)", () => {
  test("未配置(哨兵/空/残留)→ 抛带设置指引的错误", () => {
    for (const idValue of [DEFAULT_AUTO_MODEL_ID, "", "deleted-model-uuid"]) {
      state.settings.ocrModelId = idValue;
      expect(() => requireOcrModelId()).toThrow(/OCR/);
      expect(() => requireOcrModelId()).toThrow(/设置/);
    }
  });

  test("配了 → 原样返回,不猜模型", () => {
    state.settings.ocrModelId = "chat-model-uuid";
    expect(requireOcrModelId()).toBe("chat-model-uuid");
  });
});
