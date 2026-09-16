// tools/ask-user.test.ts — ask_user 共享核心(归一化/合并/回放契约)行为锁。
//
// 钉住三条不变量(双引擎 + UI 同源消费,漂移即回归):
//   1) 归一化(codex 式"不信模型"):题数钳制 1..=3、selection_type 非法/缺省落 "text"、
//      缺 id/question 的畸形项被丢弃、空选项被过滤;
//   2) 答案合并(APP 规则):multi = 已选 + 自定义文本追加最后(", " 合并);text/single 取文本框;
//   3) 契约形状(冻结):序列化产出扁平 {"answers":{qid:string}};解析器对历史值/垃圾容错。
import { describe, expect, test } from "bun:test";
import {
  ASK_USER_MAX_QUESTIONS,
  buildAskUserAnswerMap,
  buildAskUserPending,
  mergeAskUserAnswer,
  normalizeAskUserQuestions,
  parseAskUserAnswer,
  serializeAskUserAnswer,
  type AskUserQuestion,
} from "./ask-user";

describe("normalizeAskUserQuestions — 归一化与钳制", () => {
  test("缺省/非法 selection_type 一律落 text;合法值原样保留", () => {
    const result = normalizeAskUserQuestions([
      { id: "a", question: "Q1" },
      { id: "b", question: "Q2", selection_type: "bogus" },
      { id: "c", question: "Q3", selection_type: "multi" },
    ]);
    expect("questions" in result && result.questions.map((q) => q.selectionType)).toEqual([
      "text",
      "text",
      "multi",
    ]);
    const single = normalizeAskUserQuestions([{ id: "d", question: "Q4", selection_type: "single" }]);
    expect("questions" in single && single.questions[0]?.selectionType).toBe("single");
  });

  test("缺 id/question 的畸形项被丢弃;空白选项被过滤", () => {
    const result = normalizeAskUserQuestions([
      { id: "", question: "no id" },
      { id: "ok", question: "  " },
      { id: "good", question: "real", options: ["A", "", "  ", "B", 5, null] },
      "not-an-object",
      null,
    ]);
    expect("questions" in result && result.questions).toEqual([
      { id: "good", question: "real", selectionType: "text", options: ["A", "B"] },
    ]);
  });

  test("零有效问题 / 超上限 → error(回灌模型重试,不静默)", () => {
    expect("error" in normalizeAskUserQuestions([])).toBe(true);
    expect("error" in normalizeAskUserQuestions([{ id: "x" }])).toBe(true);
    const tooMany = Array.from({ length: ASK_USER_MAX_QUESTIONS + 1 }, (_, i) => ({
      id: `q${i}`,
      question: `Q${i}`,
    }));
    expect("error" in normalizeAskUserQuestions(tooMany)).toBe(true);
    expect("questions" in normalizeAskUserQuestions(tooMany.slice(0, ASK_USER_MAX_QUESTIONS))).toBe(true);
  });

  test("options 兼容字符串数组(历史/APP 契约)", () => {
    const result = normalizeAskUserQuestions([
      { id: "a", question: "pick", selection_type: "single", options: ["x", "y"] },
    ]);
    expect("questions" in result && result.questions[0]?.options).toEqual(["x", "y"]);
  });
});

describe("mergeAskUserAnswer / buildAskUserAnswerMap — 答案合并(APP 规则)", () => {
  test("multi:已选选项 + 非空自定义文本追加最后,逗号合并", () => {
    expect(mergeAskUserAnswer("multi", ["A", "B"], "再加一点")).toBe("A, B, 再加一点");
    expect(mergeAskUserAnswer("multi", ["A"], "")).toBe("A");
    expect(mergeAskUserAnswer("multi", [], "只写自定义")).toBe("只写自定义");
  });

  test("text/single:取文本框(chip 选中已写回该框);空文本回退首个选项", () => {
    expect(mergeAskUserAnswer("text", [], "自由回答")).toBe("自由回答");
    expect(mergeAskUserAnswer("single", ["Option A"], "Option A")).toBe("Option A");
    expect(mergeAskUserAnswer("single", ["Option A"], "")).toBe("Option A");
  });

  test("buildAskUserAnswerMap 按题分派,缺草稿给空串", () => {
    const questions: AskUserQuestion[] = [
      { id: "s", question: "单选", selectionType: "single", options: ["是", "否"] },
      { id: "m", question: "多选", selectionType: "multi", options: ["甲", "乙"] },
      { id: "t", question: "文本", selectionType: "text", options: [] },
    ];
    const map = buildAskUserAnswerMap(questions, {
      s: { selected: [], customText: "是" },
      m: { selected: ["甲", "乙"], customText: "丙" },
      // t 未作答
    });
    expect(map).toEqual({ s: "是", m: "甲, 乙, 丙", t: "" });
  });
});

describe("serialize/parse — 扁平契约 + 容错", () => {
  test("round-trip:serialize 产出扁平 {answers:{qid:string}},parse 原样读回", () => {
    const map = { q1: "A", q2: "x, y, 自定义" };
    expect(parseAskUserAnswer(serializeAskUserAnswer(map))).toEqual(map);
    expect(serializeAskUserAnswer(map)).toBe('{"answers":{"q1":"A","q2":"x, y, 自定义"}}');
  });

  test("parse 容错:垃圾 JSON / 非对象 / answers 非对象 → 空映射", () => {
    expect(parseAskUserAnswer("not json")).toEqual({});
    expect(parseAskUserAnswer('{"answers":"nope"}')).toEqual({});
    expect(parseAskUserAnswer("[]")).toEqual({});
    expect(parseAskUserAnswer("")).toEqual({});
  });

  test("parse 兼容防御:数组值按 multi 规则 join(面向未来形状的宽容)", () => {
    expect(parseAskUserAnswer('{"answers":{"q1":"A","q2":["a","b"],"q3":5}}')).toEqual({
      q1: "A",
      q2: "a, b",
    });
  });
});

describe("buildAskUserPending — 聊天引擎 pending 哨兵", () => {
  test("合法入参 → pending 哨兵携带归一化问题", () => {
    const pending = buildAskUserPending({
      questions: [{ id: "a", question: "Q", selection_type: "multi", options: ["x"] }],
    });
    expect("pending" in pending && pending.pending).toBe(true);
    expect("questions" in pending && pending.questions[0]?.selectionType).toBe("multi");
    expect("note" in pending && typeof pending.note).toBe("string");
  });

  test("非法入参 → error(由 runAskUserTool 抛错回灌模型)", () => {
    expect("error" in buildAskUserPending({ questions: [] })).toBe(true);
    expect("error" in buildAskUserPending({})).toBe(true);
  });
});
