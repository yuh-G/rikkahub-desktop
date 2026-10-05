// copy-name 行为锁:设置条目复制的「(N) 序号后缀」命名纪律(对齐会话 fork 的
// forkConversationTitle,方案出自安卓 458c16df/95fed05e)。
import { describe, expect, test } from "bun:test";

import { copyItemName, copySkillDirName } from "~/lib/copy-name";

describe("copyItemName(通用条目名)", () => {
  test("首次复制 → 「原名 (1)」;再复制 → (2)", () => {
    const taken = new Set(["Chat"]);
    expect(copyItemName("Chat", taken)).toBe("Chat (1)");
    taken.add("Chat (1)");
    expect(copyItemName("Chat", taken)).toBe("Chat (2)");
  });

  test("源名已带 (N) 尾缀:剥离后递增,不叠加", () => {
    const taken = new Set(["Chat", "Chat (1)", "Chat (2)"]);
    expect(copyItemName("Chat (1)", taken)).toBe("Chat (3)");
    expect(copyItemName("Chat (2)", taken)).toBe("Chat (3)");
  });

  test("候选名被占用时继续递增到首个空闲位", () => {
    const taken = new Set(["Chat", "Chat (1)", "Chat (3)"]);
    expect(copyItemName("Chat", taken)).toBe("Chat (2)");
    expect(copyItemName("Chat (1)", taken)).toBe("Chat (2)");
    expect(copyItemName("Chat (3)", taken)).toBe("Chat (4)");
  });

  test("字母尾缀不误剥;空名回退基底 Copy", () => {
    expect(copyItemName("Chat (abc)", new Set())).toBe("Chat (abc) (1)");
    expect(copyItemName("  ", new Set())).toBe("Copy (1)");
  });
});

describe("copySkillDirName(技能目录名,pi 规则禁括号)", () => {
  test("首次复制 → 原名-1;源已带 -n 剥离后递增;跳过占用", () => {
    expect(copySkillDirName("demo-skill", new Set())).toBe("demo-skill-1");
    expect(copySkillDirName("demo-skill-1", new Set(["demo-skill", "demo-skill-1"]))).toBe("demo-skill-2");
    const taken = new Set(["demo-skill", "demo-skill-1", "demo-skill-3"]);
    expect(copySkillDirName("demo-skill", taken)).toBe("demo-skill-2");
  });

  test("字母数字混合尾缀不误剥", () => {
    expect(copySkillDirName("gen-2x", new Set())).toBe("gen-2x-1");
  });
});
