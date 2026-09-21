// tools/local.ts — 本地工具执行实现
// 纪律：实现具体工具业务，不直接读写 state；依赖通过参数注入。

import { formatKeyLocal } from "../foundation/utils";
import type { JsonValue } from "../foundation/types";
import { readSystemClipboardText, writeSystemClipboardText, speakSystemText } from "./platform";
import { buildAskUserPending } from "./ask-user";

export function runGetTimeInfoTool() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(now),
    weekday_en: new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now),
    date: formatKeyLocal(now),
    time: now.toLocaleTimeString(),
    datetime: `${formatKeyLocal(now)} ${now.toLocaleTimeString()}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timestamp_ms: now.getTime(),
  };
}

export async function runClipboardTool(args: Record<string, JsonValue>) {
  const action = String(args.action ?? "").trim();
  if (action === "write") {
    const text = String(args.text ?? "");
    await writeSystemClipboardText(text);
    return { success: true, text };
  }
  if (action === "read") {
    return { text: await readSystemClipboardText() };
  }
  throw new Error("unknown action: " + action + ", must be one of [read, write]");
}

export async function runTextToSpeechTool(args: Record<string, JsonValue>) {
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("text is required");
  await speakSystemText(text);
  return { success: true };
}

export function runAskUserTool(args: Record<string, JsonValue>) {
  // 归一化(题数钳制/selection_type 校验)在共享模块;失败抛错由 execution 转 tool_result
  // 回灌模型重试,而不是静默挂一张空卡。
  const pending = buildAskUserPending(args);
  if ("error" in pending) throw new Error(pending.error);
  return pending;
}
