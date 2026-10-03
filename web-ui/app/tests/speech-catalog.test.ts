// speech-catalog.test.ts — 语音服务目录与后端/跨端契约的一致性锁。
// 目录是前端「新增」菜单与字段声明的单源;它的类型集合必须落在本端能跑的集合内,默认模板必须与
// 后端落盘兜底(media/tts.ts defaultTtsProvider、media/asr.ts defaultAsrProvider)逐字段一致——
// 否则同一服务从前端新建与后端补全会得到两套默认值。
import { describe, expect, test } from "bun:test";

import { TTS_PROVIDER_TYPES } from "@server/media/tts-providers/registry";
import { defaultTtsProvider } from "@server/media/tts";
import { defaultAsrProvider } from "@server/media/asr";
import { PC_KNOWN_ASR_TYPES } from "@server/foundation/types";
import {
  ASR_TYPES,
  asrFields,
  createAsrProvider,
  createTtsProvider,
  hasCustomizedAdvanced,
  TTS_TYPES,
  ttsFields,
  ttsSpec,
} from "~/components/settings/speech-catalog";

const withoutId = (value: Record<string, unknown>) => {
  const { id: _id, ...rest } = value;
  return rest;
};

describe("类型集合", () => {
  test("TTS 目录 = 后端已实现集合", () => {
    expect([...TTS_TYPES].sort()).toEqual([...TTS_PROVIDER_TYPES].sort());
  });
  test("ASR 目录 = 本端能跑的集合", () => {
    expect([...ASR_TYPES].sort()).toEqual([...PC_KNOWN_ASR_TYPES].sort());
  });
});

describe("默认模板与后端兜底一致", () => {
  test.each(TTS_TYPES.map((type) => [type]))("TTS %s", (type) => {
    expect(withoutId(createTtsProvider(type))).toEqual(withoutId(defaultTtsProvider(type) as never));
  });
  test("系统语音固定 id 与后端一致", () => {
    expect(createTtsProvider("system").id).toBe(defaultTtsProvider("system").id);
  });
  test.each(ASR_TYPES.map((type) => [type]))("ASR %s", (type) => {
    expect(withoutId(createAsrProvider(type))).toEqual(withoutId(defaultAsrProvider(type as never) as never));
  });
});

describe("字段声明", () => {
  test("同一类型内字段 key 不重复", () => {
    for (const type of TTS_TYPES) {
      const keys = ttsFields(type).map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    for (const type of ASR_TYPES) {
      const keys = asrFields(type).map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  test("未实现类型(APP 独有)也有通用连接字段,不渲染成空白页", () => {
    expect(ttsFields("acme_future").length).toBeGreaterThan(0);
    expect(asrFields("mimo").length).toBeGreaterThan(0);
  });
  test("高级区提示点:默认值不亮,改过才亮", () => {
    const draft = createTtsProvider("fish-audio") as Record<string, unknown>;
    const template = ttsSpec("fish-audio")!.template() as Record<string, unknown>;
    const fields = ttsFields("fish-audio");
    expect(hasCustomizedAdvanced(draft, fields, template)).toBe(false);
    expect(hasCustomizedAdvanced({ ...draft, temperature: 0.9 }, fields, template)).toBe(true);
  });
});
