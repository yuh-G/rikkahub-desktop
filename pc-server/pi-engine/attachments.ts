// pi-engine/attachments.ts — 用户消息附件 → pi prompt 输入(P4 附件面裁决落地)
//
// 裁决:pi AgentSession.prompt(text, { images }) 原生支持图片(ImageContent:
// base64+mimeType,agent-session.ts:302 PromptOptions.images),文本外的其余附件(文档/音视频占位/OCR)
// 在聊天引擎里本就是文本化进消息——两边共用同一母本 contentPartsForApi
// (inference-engine/message-builder):文档全文前置(issue6 长上下文语义)、模型无
// IMAGE 能力时图片降级 OCR 文本、data URL 物化,全部原样继承,pi 面零自创口径。
//
// 顺序语义的一处诚实披露:pi 的 images 是随消息附带的列表,不保留"图片夹在两段
// 文字中间"的原位;文本条目按原序拼接,图片整体后置——与 Claude/OpenAI 消息里
// 附件作为独立 content block 的行为等价,模型侧无感。

import type { MessagePart, Model } from "../foundation/types";
import { contentPartsForApi, parseDataUrl } from "../inference-engine/message-builder";

export interface PiPromptInput {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}

/** 末条用户消息的 parts → pi prompt 输入。text 为空串表示无可发送内容(调用方拒发)。 */
export function piPromptInputFromParts(parts: MessagePart[], model: Model): PiPromptInput {
  const content = contentPartsForApi(parts, model);
  const texts: string[] = [];
  const images: PiPromptInput["images"] = [];
  for (const entry of content) {
    if (entry?.type === "text") {
      const text = String(entry.text ?? "");
      if (text) texts.push(text);
      continue;
    }
    if (entry?.type === "image_url") {
      const url = String(entry.image_url?.url ?? "");
      const parsed = parseDataUrl(url);
      // 非 data URL(远程 http 图等):pi 进程无由代取,降级占位文本——与聊天引擎
      // Claude 路径 claudeBlocksFromUiParts 的降级文案同款。
      if (parsed) images.push({ type: "image", data: parsed.data, mimeType: parsed.mime });
      else if (url) texts.push(`[Image: ${url}]`);
    }
  }
  return { text: texts.join("\n\n").trim(), images };
}
