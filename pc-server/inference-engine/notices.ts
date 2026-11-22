// inference-engine/notices.ts — notice 片段发给模型时的位置(照 APP 的 expandNotices)
//
// notice 存在消息里:一轮进行中到达的追加在助手消息里,空闲时到达的单独存成只有 notice 的用户消息。发给模型时在原位置
// 拆成一条用户消息,只带 text(title 只给界面)。在输入变换(模板、时间提醒、注入)之后做,请求前缀不变,能命中提示词缓存。
// 工作区引擎不走这里:pi 的回退编码在 pi-engine/context-encoder 里按同一规则处理。

import type { Message, MessagePart } from "../foundation/types";

const hasNotice = (message: Message) => message.parts.some((part) => part.type === "notice");

/** 没有 notice 的消息原样返回(同一个对象)。拆出来的用户消息 id 由所在消息 id 与片段下标确定,同一历史两次结果相同。 */
export function expandNotices(messages: Message[]): Message[] {
  if (!messages.some(hasNotice)) return messages;
  return messages.flatMap((message) => {
    if (!hasNotice(message)) return [message];
    const out: Message[] = [];
    let buffer: MessagePart[] = [];
    const flush = () => {
      if (buffer.length > 0) out.push({ ...message, parts: buffer });
      buffer = [];
    };
    message.parts.forEach((part, index) => {
      if (part.type !== "notice") {
        buffer.push(part);
        return;
      }
      flush();
      out.push({
        id: `${message.id}:notice:${index}`,
        role: "USER",
        parts: [{ type: "text", text: part.text }],
        annotations: [],
        createdAt: message.createdAt,
        finishedAt: null,
        modelId: null,
        usage: null,
        translation: null,
      });
    });
    flush();
    return out;
  });
}
