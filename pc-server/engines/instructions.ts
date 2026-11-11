// engines/instructions.ts — 系统提示词侧的应用资产 → 契约 EngineInstructions(应用侧组装)
//
// 引擎只拿数据:appendSystemPrompt 条目(人设/搜索指引/记忆/注入面/教学行)、全局 AGENTS.md
// 的路径与内容、技能库目录与启用名单。渲染格式(<project_context>、<available_skills> 等)归引擎。
//
// 冻结纪律(§4.8/§9.2):appendSystemPrompt 同会话内必须逐字节稳定。
// - 人设:renderTemplate 含时间类模板变量,渲染结果按 会话+助手+原文指纹 冻结——
//   原文中途被改 → 指纹变 → 重渲染(与聊天引擎"改人设立即生效"同语义,破一次缓存);
//   原文不变 → 时间变量定格在首轮。
// - 记忆/最近会话:复用聊天引擎的 frozenContextBlocks(同一冻结生命周期与失效面:设置页
//   手动改记忆 → invalidateContextSnapshots → 两个引擎同时重建)。
// - 搜索指引/教学行:内容只随设置变(服务名/技能库路径),天然稳定。
// 全局 AGENTS.md 与技能清单每轮读一次(用户编辑下轮生效,与技能开关同语义)。

import { mkdirSync } from "node:fs";
import type { Assistant, Conversation, Model } from "../foundation/types";
import { getStringArray, renderTemplate } from "../foundation/utils";
import { globalAgentsPath, skillsDir } from "../foundation/paths";
import { readGlobalAgentsFile } from "../agents/global-agents";
import { frozenContextBlocks } from "../inference-engine/context-snapshots";
import { templateVariables } from "../inference-engine/message-enrichment";
import { buildSearchContext } from "../search";
import type { EngineInstructions } from "./contract";

// ---- 人设冻结快照(LRU,套路同 inference-engine/context-snapshots) ----

const MAX_SNAPSHOTS = 200;
const personaSnapshots = new Map<string, string>();

/** 生效人设原文:会话级 systemPrompt(助手允许时)优先,否则助手人设——
 *  与聊天引擎 conversationTransformedMessages 的 effectiveSystemPrompt 同一规则。 */
function personaSource(conversation: Conversation, assistant: Assistant): string {
  const conversationPrompt = assistant.allowConversationSystemPrompt
    ? String(conversation.systemPrompt ?? "").trim()
    : "";
  return conversationPrompt || assistant.systemPrompt.trim();
}

function frozenPersona(conversation: Conversation, assistant: Assistant, model: Model): string {
  const source = personaSource(conversation, assistant);
  if (!source) return "";
  const key = `${conversation.id}|${assistant.id}|${Bun.hash(source).toString(16)}`;
  const hit = personaSnapshots.get(key);
  if (hit !== undefined) {
    personaSnapshots.delete(key);
    personaSnapshots.set(key, hit);
    return hit;
  }
  const rendered = renderTemplate(source, templateVariables("", "system", assistant, model));
  personaSnapshots.set(key, rendered);
  if (personaSnapshots.size > MAX_SNAPSHOTS) {
    const oldest = personaSnapshots.keys().next().value;
    if (oldest !== undefined) personaSnapshots.delete(oldest);
  }
  return rendered;
}

/** 单测隔离用。 */
export function invalidatePersonaSnapshots(): void {
  personaSnapshots.clear();
}

// ---- appendSystemPrompt 组装 ----

/** 技能安装落点教学(§3.1:模型自装资源必须落到应用的技能库;<available_skills> 的
 *  location 自带自举,这行把"装新技能装到哪"说死)+ 审批语义披露(§3.4 安全披露:
 *  工具可能要用户批准,被拒就调整,别原样重试)。 */
function stableGuidanceLines(): string {
  const dir = skillsDir.replace(/\\/g, "/");
  return [
    `To install a new skill for the user, create \`${dir}/<skill-name>/SKILL.md\` (with name and description frontmatter). It becomes available once enabled in the app settings.`,
    "Some tool calls require explicit user approval before they run. A denied call returns an error with the reason — respect the decision and adjust your approach instead of retrying the same call.",
  ].join("\n");
}

/** appendSystemPrompt 条目(有序;引擎以 \n\n join 追加在自己的 Guidelines 之后)。分段各有
 *  恰当冻结源,拼接结果同会话内字节稳定。extra = 系统位注入(before/after_system_prompt),
 *  位置在人设/记忆之后、教学行之前——与聊天引擎 systemParts 同位。导出供测试断言冻结性。 */
export function buildAppendSystemPrompt(
  conversation: Conversation,
  assistant: Assistant,
  model: Model,
  extra?: string[],
): string[] {
  const [memoryBlock, recentChatsBlock] = frozenContextBlocks(assistant, conversation.id);
  return [
    frozenPersona(conversation, assistant, model),
    buildSearchContext(),
    memoryBlock,
    recentChatsBlock,
    ...(extra ?? []),
    stableGuidanceLines(),
  ].filter(Boolean);
}

export function buildEngineInstructions(
  conversation: Conversation,
  assistant: Assistant,
  model: Model,
  extraAppendSystemPrompt?: string[],
): EngineInstructions {
  // 技能库目录是应用的家,确保存在(与 tools/skills.listSkills 同款自愈)——否则冷启动
  // 未开过技能页时,引擎每轮加载技能都会报"path does not exist"。
  mkdirSync(skillsDir, { recursive: true });
  const globalFile = readGlobalAgentsFile();
  return {
    appendSystemPrompt: buildAppendSystemPrompt(conversation, assistant, model, extraAppendSystemPrompt),
    globalAgentsFile: globalFile.exists ? { path: globalAgentsPath, content: globalFile.content } : null,
    skills: { dir: skillsDir, enabled: getStringArray(assistant.enabledSkills) },
  };
}
