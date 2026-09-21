// inference-engine/conversation-encoding.ts — 会话 → 三家 Provider 请求体的编码层
// （模板变量、提示词注入、OpenAI messages / Responses API input / Google contents 构建）
// 纪律：纯搬迁自 server.ts（阶段 5.3d），行为不变。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, Model } from "../foundation/types";
import { applyPlaceholders, cloneJson, getStringArray, message, renderTemplate, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { frozenContextBlocks } from "./context-snapshots";
import { buildSearchContext } from "../search";
import { findModel } from "../model-providers";
import { listSkills } from "../tools/skills";
import { conversationFunctionTools } from "../tools/bound";
import { GOOGLE_SAFETY_SETTINGS, apiContentFromParts, apiContentText, appendAssistantApiMessages, googleContentsFromApiMessages, googleFunctionDeclarations, googleGenerationConfig, hasBuiltInTool, hostOfProvider, responseApiMessagesFromUiMessages, supportsAbility, supportsOutputModality } from "./message-builder";
import { responsesHistoryReasoningAllowed } from "../model-providers/request-dialect";
import { isEmptyAssistantPlaceholder } from "./parts";
import { enrichMessages, templateVariables } from "./message-enrichment";

// 消息模板/时间提醒/lorebook+模式注入/滞回截断 已上收至 message-enrichment.ts
// (引擎无关层);本文件只负责"富化产物 → 三家 Provider 请求体"的编码。

function buildSkillsContext(assistant: Assistant) {
  const enabled = new Set(getStringArray(assistant.enabledSkills));
  const available = listSkills().filter((skill) => enabled.has(skill.name));
  if (available.length === 0) return "";
  const body = available
    .map((skill) => `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`)
    .join("\n");
  return `**Skills**
You have access to the following skills. Use the \`use_skill\` tool to load a skill's instructions when the user's request matches.
<available_skills>
${body}
</available_skills>`;
}

export function buildGoogleRequestBody(messagesForApi: ApiMessage[], modelItem: Model, assistant: Assistant) {
  const systemContent = messagesForApi.find((item) => item.role === "system")?.content;
  const hasImageOutput = supportsOutputModality(modelItem, "IMAGE");
  const functionTools = supportsAbility(modelItem, "TOOL")
    ? conversationFunctionTools(assistant, modelItem)
    : [];
  const functionDeclarations = googleFunctionDeclarations(functionTools);
  // 内置工具（googleSearch/urlContext）目前与函数工具互斥，优先内置工具，镜像安卓
  // buildCompletionRequestBody:446-468（model.tools 覆盖 functionDeclarations）。
  const builtInTools: Record<string, JsonValue>[] = [];
  if (hasBuiltInTool(modelItem, "search")) builtInTools.push({ googleSearch: {} });
  if (hasBuiltInTool(modelItem, "url_context") || hasBuiltInTool(modelItem, "urlContext")) {
    builtInTools.push({ urlContext: {} });
  }
  const tools = builtInTools.length
    ? builtInTools
    : functionDeclarations.length
      ? [{ functionDeclarations }]
      : undefined;
  const body: Record<string, JsonValue> = {
    // system 在图片输出模型上不发送，对齐安卓 buildCompletionRequestBody:352。
    ...(systemContent && !hasImageOutput
      ? { systemInstruction: { parts: [{ text: apiContentText(systemContent) }] } }
      : {}),
    generationConfig: googleGenerationConfig(modelItem, assistant),
    contents: googleContentsFromApiMessages(messagesForApi),
    ...(tools ? { tools } : {}),
    safetySettings: GOOGLE_SAFETY_SETTINGS,
  };
  return body;
}

// 按工具边界把 ASSISTANT 消息的 parts 分组。镜像安卓
// ai/src/main/java/me/rerere/ai/provider/providers/ProviderMessageUtils.kt 的
// groupPartsByToolBoundary：连续的"已执行 tool" parts 合为一组，与它们之前的
// content（含 reasoning）共同组成一条 assistant 消息，避免把同一个 reasoning
// 在多次 tool flush 中提前清空——这是 DeepSeek V4 thinking 模式要求每条带
// tool_calls 的 assistant 消息都必须携带 reasoning_content 的核心修复点。
//
// 本函数现在只做"选路 + system 装配 + 空占位剔除",消息加工(模板/提醒/注入/截断)
// 全部委托 message-enrichment.enrichMessages——pi 工作区引擎吃同一份裁决。
function conversationTransformedMessages(conversation: Conversation, assistant: Assistant) {
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // 1.5.0 跟进安卓 Migration_16_17:truncateIndex("清除上下文"分割线)机制废弃,
  // 上下文裁剪只剩两条正交机制——助手级 contextMessageLimit 切片 + 压缩对话历史。
  const visibleNodes = conversation.messages;
  // 剔除尾部"正在生成"的空 ASSISTANT 占位后再富化,见 isEmptyAssistantPlaceholder
  // 的说明(issue #16 + 工具恢复兼容)。
  const contextNodes = visibleNodes.filter((node, index) => {
    if (index !== visibleNodes.length - 1) return true;
    const selected = node.messages[node.selectIndex] ?? node.messages[0];
    return !isEmptyAssistantPlaceholder(selected);
  });
  const selectedMessages = contextNodes
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean)
    .map((msg) => cloneJson(msg));

  const conversationSystemPrompt = assistant.allowConversationSystemPrompt
    ? String(conversation.systemPrompt ?? "").trim()
    : "";
  const effectiveSystemPrompt = conversationSystemPrompt || assistant.systemPrompt.trim();
  // 专题11-P1-2:system 各区块按“稳定→易变”排列。专题12 进一步把记忆/最近会话
  // 冻结为会话级快照(context-snapshots.ts)。P6 退役:原居首的工作区段已移除——
  // 工作区可用必走 pi 会话(agent 身份由 pi 系统提示词+appendSystemPrompt 承载)。
  const systemParts = [
    effectiveSystemPrompt
      ? renderTemplate(effectiveSystemPrompt, templateVariables("", "system", assistant, picked.model))
      : "",
    buildSkillsContext(assistant),
    buildSearchContext(),
    ...frozenContextBlocks(assistant, conversation.id),
  ].filter(Boolean);

  const systemMessage = systemParts.length
    ? message("SYSTEM", [{ type: "text", text: systemParts.join("\n\n") }])
    : null;

  const enriched = enrichMessages(selectedMessages, {
    conversation,
    assistant,
    model: picked.model,
    // 聊天引擎无持久摘要,无压缩切点锚;工作区引擎路径传 effectiveEngineCompaction 切点(P9)。
    timeReminderAnchor: systemMessage ?? undefined,
  });

  // 系统位注入(before/after_system_prompt)并入 system 面:before 在前、after 在后,
  // 与安卓 PromptInjectionTransformer 的 system 位语义一致;无 system 时注入单独成条。
  const systemWithInjections = [
    enriched.systemInjectionBefore,
    systemMessage ? textFromParts(systemMessage.parts) : "",
    enriched.systemInjectionAfter,
  ].filter(Boolean).join("\n");

  const internalMessages: Message[] = [];
  if (systemWithInjections) {
    internalMessages.push(message("SYSTEM", [{ type: "text", text: systemWithInjections }]));
  }
  internalMessages.push(...enriched.messages);
  return { messages: internalMessages, picked };
}

export function conversationMessagesForApi(
  conversation: Conversation,
  assistant: Assistant,
  // 对齐安卓 commit e63d017：OpenAI providerSetting.includeHistoryReasoning
  // 控制是否把历史 assistant 消息的 reasoning_content 回传给上游。默认 true，
  // 与安卓 ChatCompletionsAPI.buildMessages 的默认值一致。
  includeHistoryReasoning: boolean = true,
) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);

  const items: ApiMessage[] = [];
  for (const selected of transformedMessages) {
    const role = selected.role === "SYSTEM" ? "system" : selected.role === "TOOL" ? "tool" : selected.role === "ASSISTANT" ? "assistant" : "user";
    if (selected.role === "ASSISTANT") {
      appendAssistantApiMessages(items, selected, includeHistoryReasoning);
      continue;
    }
    const rawContent = textFromParts(selected.parts);
    const content = apiContentFromParts(selected.parts, rawContent, picked.model);
    if (!content) continue;
    items.push({ role, content });
  }
  return items;
}

export function conversationResponseApiInput(conversation: Conversation, assistant: Assistant) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  // 历史思考项回传方言：仅官方 OpenAI 主机（第三方 Responses 端点形态各异，火山
  // 直接 400，见 responsesHistoryReasoningAllowed 头注）；另尊重 provider 级
  // includeHistoryReasoning 开关（与 chat-completions 路径 e63d017 同语义——
  // Responses 路径只有 openai 型 provider 会走到，无需再判 type）。
  const includeReasoningItems = responsesHistoryReasoningAllowed(hostOfProvider(picked.provider))
    && picked.provider.includeHistoryReasoning !== false;
  return responseApiMessagesFromUiMessages(transformedMessages, picked.model, includeReasoningItems);
}

export function conversationResponseApiInstructions(conversation: Conversation, assistant: Assistant) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  return transformedMessages
    .filter((item) => item.role === "SYSTEM")
    .map((item) =>
      applyPlaceholders(
        textFromParts(item.parts),
        templateVariables(textFromParts(item.parts), "system", assistant, picked.model),
      )
    )
    .filter(Boolean)
    .join("\n");
}
