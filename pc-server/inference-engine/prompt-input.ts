// inference-engine/prompt-input.ts — 用户消息 parts → 引擎可见的输入(文本 + base64 图片)
//
// 契约里的 PromptInput 就是本函数的产物:应用侧把附件物化好(读文件表、OCR 降级、文档
// 全文前置),引擎拿到的只有纯数据。与聊天引擎共用同一母本 contentPartsForApi
// (inference-engine/message-builder):文档全文前置(issue6 长上下文语义)、模型无 IMAGE
// 能力时图片降级 OCR 文本、data URL 物化,全部原样继承。
//
// 顺序语义:图片随消息整体后置,不保留"夹在两段文字中间"的原位;文本条目按原序拼接——
// 与 Claude/OpenAI 消息里附件作为独立 content block 的行为等价,模型侧无感。

import type { PromptInput } from "../engines/contract";
import type { Message, MessagePart, Model } from "../foundation/types";
import { parseDataUrl } from "../foundation/utils";
import { contentPartsForApi } from "./message-builder";

/** 用户消息的 parts → 引擎输入。text 为空串且无图片表示无可发送内容(调用方拒发)。 */
export function promptInputFromParts(parts: MessagePart[], model: Model): PromptInput {
  const content = contentPartsForApi(parts, model);
  const texts: string[] = [];
  const images: PromptInput["images"] = [];
  for (const entry of content) {
    if (entry?.type === "text") {
      const text = String(entry.text ?? "");
      if (text) texts.push(text);
      continue;
    }
    if (entry?.type === "image_url") {
      const url = String(entry.image_url?.url ?? "");
      const parsed = parseDataUrl(url);
      // 非 data URL(远程 http 图等):引擎无由代取,降级占位文本——与聊天引擎
      // Claude 路径 claudeBlocksFromUiParts 的降级文案同款。
      if (parsed) images.push({ type: "image", data: parsed.data, mimeType: parsed.mime });
      else if (url) texts.push(`[Image: ${url}]`);
    }
  }
  return { text: texts.join("\n\n").trim(), images };
}

/** 一段历史里 USER 行的模型可见输入,按消息 id。没有可发送内容的行不登记。 */
export function userInputsFor(messages: Message[], model: Model): Record<string, PromptInput> {
  const inputs: Record<string, PromptInput> = {};
  for (const message of messages) {
    if (message.role !== "USER") continue;
    const input = promptInputFromParts(message.parts, model);
    if (input.text || input.images.length) inputs[message.id] = input;
  }
  return inputs;
}
