// persistence/provider-tombstone.test.ts — 预置供应商/助手删除墓碑回归(R1-12 搜索服务同款)。
// 锁住的语义:①无墓碑时缺失的预置项照常补齐(老用户升级行为不变);②有墓碑的预置项
// 不复活、其余照补;③显式在场的条目不受墓碑影响(备份恢复带回的旧列表以在场为准);
// ④墓碑去重规范化。id 常量镜像 model-providers/defaultSettings 的预置 UUID——改预置 id
// 时同步此处(与 BUILTIN_PROVIDER_ORDER 同源)。

import { describe, expect, test } from "bun:test";
import { normalizeState } from "./state-load";

const OPENAI_ID = "1eeea727-9ee5-4cae-93e6-6fb01a4d051e";
const DEEPSEEK_ID = "f099ad5b-ef03-446d-8e78-7e36787f780b";
// defaults.ts 第二个预置助手(出厂即有固定 UUID);第一个默认助手 id 见 DEFAULT_ASSISTANT_ID。
const PRESET_ASSISTANT_ID = "3d47790c-c415-4b90-9388-751128adb0a0";

function providerIds(state: ReturnType<typeof normalizeState>): string[] {
  return state.settings.providers.map((item) => item.id);
}

function assistantIds(state: ReturnType<typeof normalizeState>): string[] {
  return state.settings.assistants.map((item) => item.id);
}

describe("预置供应商删除墓碑", () => {
  test("无墓碑:缺失的预置供应商照常补齐(老用户升级行为不变)", () => {
    const state = normalizeState({
      settings: { providers: [{ id: "custom-1", name: "我的中转", apiKey: "sk" }], assistants: [] } as any,
    });
    const ids = providerIds(state);
    expect(ids).toContain("custom-1");
    expect(ids).toContain(OPENAI_ID);
    expect(ids).toContain(DEEPSEEK_ID);
  });

  test("有墓碑:删掉的预置供应商不复活,其余照补", () => {
    const state = normalizeState({
      settings: {
        providers: [{ id: "custom-1", name: "我的中转", apiKey: "sk" }],
        dismissedProviderIds: [OPENAI_ID],
        assistants: [],
      } as any,
    });
    const ids = providerIds(state);
    expect(ids).not.toContain(OPENAI_ID);
    expect(ids).toContain(DEEPSEEK_ID);
    expect(ids).toContain("custom-1");
  });

  test("显式在场优先:墓碑不删列表里已有的同 id 条目(备份恢复带回旧列表的场景)", () => {
    const state = normalizeState({
      settings: {
        providers: [{ id: OPENAI_ID, name: "手动加回的 OpenAI", apiKey: "sk" }],
        dismissedProviderIds: [OPENAI_ID],
        assistants: [],
      } as any,
    });
    const ids = providerIds(state);
    expect(ids.filter((x) => x === OPENAI_ID)).toHaveLength(1); // 保留且不重复
  });

  test("墓碑去重规范化", () => {
    const state = normalizeState({
      settings: {
        providers: [],
        dismissedProviderIds: [OPENAI_ID, OPENAI_ID, 42 as unknown as string],
        assistants: [],
      } as any,
    });
    expect(state.settings.dismissedProviderIds).toEqual([OPENAI_ID]);
  });
});

describe("预置助手删除墓碑", () => {
  test("无墓碑:缺失的预置助手照常补齐", () => {
    const state = normalizeState({
      settings: { providers: [], assistants: [{ id: "my-assistant", name: "我的助手" }] as any } as any,
    });
    expect(assistantIds(state)).toContain(PRESET_ASSISTANT_ID);
  });

  test("有墓碑:删掉的预置助手不复活,用户自定义助手不受影响", () => {
    const state = normalizeState({
      settings: {
        providers: [],
        assistants: [{ id: "my-assistant", name: "我的助手" }],
        dismissedAssistantIds: [PRESET_ASSISTANT_ID],
      } as any,
    });
    const ids = assistantIds(state);
    expect(ids).not.toContain(PRESET_ASSISTANT_ID);
    expect(ids).toContain("my-assistant");
  });
});
