// fork 标题「(N) 序号 + 防叠加」的行为锁(对齐安卓 ChatServiceTest 同名用例集)。
import { describe, expect, test } from "bun:test";

import { forkConversationTitle } from "./fork-title";

describe("forkConversationTitle", () => {
  test("无 (N) 尾缀:取 (1),被占则递增到首个空闲", () => {
    expect(forkConversationTitle("Chat", new Set())).toBe("Chat(1)");
    expect(forkConversationTitle("Chat", new Set(["Chat(1)"]))).toBe("Chat(2)");
    expect(forkConversationTitle("Chat", new Set(["Chat(1)", "Chat(2)"]))).toBe("Chat(3)");
    // 空洞跳号:1、3 已占,新 fork 取 2 而非 4 —— 语义是「空闲序号」不是「最大+1」。
    expect(forkConversationTitle("Chat", new Set(["Chat(1)", "Chat(3)"]))).toBe("Chat(2)");
  });

  test("源标题已带 (N) 尾缀:剥离后递增,不叠加", () => {
    expect(forkConversationTitle("Chat(1)", new Set())).toBe("Chat(2)");
    expect(forkConversationTitle("Chat(1)", new Set(["Chat(2)", "Chat(3)"]))).toBe("Chat(4)");
  });

  test("字母后缀不误剥(Chat(abc) 不是数字尾缀)", () => {
    expect(forkConversationTitle("Chat(abc)", new Set())).toBe("Chat(abc)(1)");
  });

  test("跨会话撞名让位:空闲序号只看同助手标题全集", () => {
    expect(forkConversationTitle("会议纪要", new Set(["会议纪要(1)", "会议纪要(2)"]))).toBe("会议纪要(3)");
  });

  test("空标题:以 Fork 为基底编号", () => {
    expect(forkConversationTitle("", new Set())).toBe("Fork(1)");
    expect(forkConversationTitle("   ", new Set(["Fork(1)"]))).toBe("Fork(2)");
  });

  test("尾缀前后空白被规整:不产出 \"Chat (1)\" 混合形态", () => {
    expect(forkConversationTitle("Chat ", new Set())).toBe("Chat(1)");
    expect(forkConversationTitle("Chat (2)", new Set())).toBe("Chat(3)");
  });
});
