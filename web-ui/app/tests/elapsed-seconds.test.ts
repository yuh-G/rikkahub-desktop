// elapsed-seconds.test.ts — 计时口径单一裁决点(resolveElapsedSeconds)的行为锁。
// issue #59 残余治本:终点戳缺失 ≠ 此刻还在跑——只有 live(消息生成中/审批等待挂起)
// 才允许以"现在"走表;孤儿消息(进程被杀/停止/打断遗留)一律 null,不再无限走表。
import { describe, expect, test } from "bun:test";

import { resolveElapsedSeconds } from "~/hooks/use-elapsed-since";

const T0 = 1_700_000_000_000;

describe("resolveElapsedSeconds", () => {
  test("终点戳在场:定格差值(秒)", () => {
    expect(resolveElapsedSeconds(T0, T0 + 45_000, false, T0 + 10 * 60_000)).toBe(45);
  });

  test("终点戳在场且 live 已翻假:同样定格(live 不覆盖真实终点)", () => {
    expect(resolveElapsedSeconds(T0, T0 + 45_000, true, T0 + 10 * 60_000)).toBe(45);
  });

  test("定格不足 1 秒进位显示 1 秒", () => {
    expect(resolveElapsedSeconds(T0, T0 + 400, true, T0 + 5_000)).toBe(1);
  });

  test("终点缺失 + live:以 now 走表", () => {
    expect(resolveElapsedSeconds(T0, null, true, T0 + 33_000)).toBe(33);
  });

  test("终点缺失 + live:不足 1 秒静默(null,不闪 0s)", () => {
    expect(resolveElapsedSeconds(T0, null, true, T0 + 400)).toBeNull();
  });

  test("终点缺失 + 非 live:孤儿卡时长未知,null(不再对墙钟走表)", () => {
    // 这是治 #59 残余的核心断言:历史会话/重启遗留的消息,无论 now 走到多远都是 null。
    expect(resolveElapsedSeconds(T0, null, false, T0 + 365 * 24 * 3600_000)).toBeNull();
  });

  test("live=false 不能复活已定格的值:终点仍在场时优先终点", () => {
    expect(resolveElapsedSeconds(T0, T0 + 45_000, false, T0 + 999_999)).toBe(45);
  });
});
