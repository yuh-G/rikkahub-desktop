import i18n from "~/i18n";
import type { ConversationDto, MessageDto, ToolPart, UIMessagePart } from "~/types";

function t(key: string, params?: Record<string, unknown>): string {
  return i18n.t(`message:chat_message.${key}`, params ?? {});
}

function roleLabel(role: string): string {
  if (role === "USER") return `**${t("md_role_user")}**`;
  if (role === "ASSISTANT") return `**${t("md_role_assistant")}**`;
  return `**${t("md_role_system")}**`;
}

// 把图片 url 转成 data URL(base64 内联),让导出的 md 离开 app 后图片仍可见。
// 对齐 APP Export.kt 的 encodeBase64 内联策略 —— 否则 /api/files/... 在分享出去的 md 里全是死链。
// fetch 失败(跨域/网络/404)时返回 null,调用方回退到原始 url。
async function toInlineDataUrl(url: string): Promise<string | null> {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const res = await fetch(trimmed);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function imageMarkdown(url: string): Promise<string> {
  const dataUrl = await toInlineDataUrl(url);
  return `![${t("copy_image")}](${dataUrl ?? url})`;
}

// ToolPart.input 已是 JSON 字符串;美化失败则原样返回
function formatToolInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

async function toolPartLines(part: ToolPart): Promise<string[]> {
  const lines: string[] = [];
  lines.push(`${t("md_tool_label")}: \`${part.toolName}\``);
  if (part.toolCallId.trim()) {
    lines.push(`- ${t("md_tool_call_id")}: \`${part.toolCallId}\``);
  }
  lines.push(`${t("md_tool_input")}:`);
  lines.push("```json");
  lines.push(formatToolInput(part.input));
  lines.push("```");
  lines.push("");

  if (part.output.length > 0) {
    lines.push(`${t("md_tool_output")}:`);
    lines.push("");
    for (const out of part.output) {
      if (out.type === "text" && out.text.trim()) {
        lines.push("```text");
        lines.push(out.text);
        lines.push("```");
      } else if (out.type === "reasoning" && out.reasoning.trim()) {
        lines.push(...out.reasoning.trim().split("\n").map((l) => `> ${l}`));
      } else if (out.type === "image" && out.url) {
        lines.push(await imageMarkdown(out.url));
      } else if (out.type === "document" && out.fileName) {
        lines.push(`[${t("md_document_label")}: ${out.fileName}](${out.url})`);
      } else if (out.type === "video" && out.url) {
        lines.push(`[${t("md_video_label")}](${out.url})`);
      } else if (out.type === "audio" && out.url) {
        lines.push(`[${t("md_audio_label")}](${out.url})`);
      }
    }
    lines.push("");
  }
  return lines;
}

async function partToLines(part: UIMessagePart, includeReasoning: boolean): Promise<string[]> {
  switch (part.type) {
    case "text": {
      const trimmed = part.text.trim();
      return trimmed ? [trimmed, ""] : [];
    }
    case "reasoning": {
      if (!includeReasoning) return [];
      const trimmed = part.reasoning.trim();
      if (!trimmed) return [];
      // 对齐 APP:每行加 > 前缀(纯引用块),不加 "Thinking:" 标题
      return [...trimmed.split("\n").map((l) => `> ${l}`), ""];
    }
    case "image":
      return [await imageMarkdown(part.url), ""];
    case "document":
      return [`[${t("md_document_label")}: ${part.fileName}](${part.url})`, ""];
    case "video":
      return [`[${t("md_video_label")}](${part.url})`, ""];
    case "audio":
      return [`[${t("md_audio_label")}](${part.url})`, ""];
    case "tool":
      return toolPartLines(part);
    default:
      return [];
  }
}

async function messageToLines(message: MessageDto, includeReasoning: boolean): Promise<string[]> {
  const lines: string[] = [];
  lines.push(`${roleLabel(message.role)}:`);
  lines.push("");
  for (const part of message.parts) {
    lines.push(...(await partToLines(part, includeReasoning)));
  }
  return lines;
}

export async function convertMessageToMarkdown(
  message: MessageDto,
  includeReasoning: boolean,
): Promise<string> {
  const lines: string[] = [];
  for (const part of message.parts) {
    lines.push(...(await partToLines(part, includeReasoning)));
  }
  return lines.join("\n").trim();
}

export async function convertMessagesToMarkdown(
  messages: MessageDto[],
  includeReasoning: boolean,
  title?: string,
): Promise<string> {
  const lines: string[] = [];
  const header = title?.trim() ?? "";
  if (header) {
    lines.push(`# ${header}`);
    lines.push("");
  }
  lines.push(`*${t("md_exported_at", { date: new Date().toLocaleString() })}*`);
  lines.push("");

  for (const message of messages) {
    lines.push(...(await messageToLines(message, includeReasoning)));
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function convertConversationToMarkdown(
  detail: ConversationDto,
  includeReasoning: boolean,
): Promise<string> {
  const lines: string[] = [];
  if (detail.title) {
    lines.push(`# ${detail.title}`);
    lines.push("");
  }
  lines.push(`*${t("md_exported_at", { date: new Date().toLocaleString() })}*`);
  lines.push("");

  for (const node of detail.messages) {
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (!message) continue;
    lines.push(...(await messageToLines(message, includeReasoning)));
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function safeMarkdownFilename(name: string, fallback = "conversation") {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return `${(cleaned || fallback).slice(0, 120)}.md`;
}
