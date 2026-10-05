// editing-store 行为锁:消息编辑绑定按会话键控全局存活。
//
// 背景(对齐安卓 4a3eefc1 的 PC 缺口):旧实现把 EditingSession 放窗格本地 useState
// 且切换会话即清,而编辑文本在 drafts store 里按会话保留——切走再切回,输入框带着
// 编辑中的内容但绑定已丢,按发送静默腐化成"发新消息"。此测试钉住:绑定跨"切换"
// 存活、终局路径显式清键、批量删除不留孤儿。
import { beforeEach, describe, expect, test } from "bun:test";

import {
  useEditingStore,
  type EditingSession,
} from "~/stores/editing-store";

function session(messageId: string): EditingSession {
  return {
    messageId,
    sourceParts: [{ type: "text", text: "原文" }],
    textPartIndex: 0,
  };
}

const store = () => useEditingStore.getState();

beforeEach(() => {
  useEditingStore.setState({ byConversation: {} });
});

describe("编辑绑定按会话键控", () => {
  test("beginEdit 后按会话可读回;不同会话互不串扰", () => {
    store().beginEdit("c1", session("m1"));
    store().beginEdit("c2", session("m2"));
    expect(store().byConversation["c1"]?.messageId).toBe("m1");
    expect(store().byConversation["c2"]?.messageId).toBe("m2");
  });

  test("endEdit 只清目标会话的键,其它会话的编辑存活(切走再切回续编辑)", () => {
    store().beginEdit("c1", session("m1"));
    store().beginEdit("c2", session("m2"));
    store().endEdit("c1");
    expect(store().byConversation["c1"]).toBeUndefined();
    expect(store().byConversation["c2"]?.messageId).toBe("m2");
  });

  test("endEdit 幂等:无键时再次清空是 no-op", () => {
    expect(() => store().endEdit("cX")).not.toThrow();
    expect(store().byConversation).toEqual({});
  });

  test("endEditMany(会话删除)批量清键,只清存在的", () => {
    store().beginEdit("c1", session("m1"));
    store().beginEdit("c3", session("m3"));
    store().endEditMany(["c1", "c2", "c3"]);
    expect(store().byConversation).toEqual({});
  });

  test("窄选择器语义(经 getState 对照,hook 本体在组件里跑):无键/未知会话回落 null", () => {
    store().beginEdit("c1", session("m1"));
    const select = useEditingStore.getState().byConversation;
    // 选择器的回落分支与命中分支,与 useConversationEditingSession 同式
    const pick = (id: string | null) => (id ? (select[id] ?? null) : null);
    expect(pick(null)).toBeNull();
    expect(pick("c1")?.messageId).toBe("m1");
    expect(pick("cX")).toBeNull();
  });
});
