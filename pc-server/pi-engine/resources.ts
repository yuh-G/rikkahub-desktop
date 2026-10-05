// pi-engine/resources.ts — pi 会话资源装配(P4,方案 §三/§4.2 的落点)
//
// 统一管理模型的执行层:每类资源只有一个"家",pi 每次会话由此注满——
// - 技能:唯一技能库 pc-data/skills/(additionalSkillPaths)+ noSkills:true 在路径层
//   封死 pi 默认目录(agentDir/skills 与 cwd/.pi/skills,"不搞项目级"落实在源头);
//   skillsOverride 再做 assistant.enabledSkills 白名单 + 滤 project 来源(防御纵深)。
// - 设置:SettingsManager.inMemory + projectTrusted:false——零文件 I/O,工作区里的
//   .pi/settings.json 与 .pi/SYSTEM.md(resource-loader.discoverSystemPromptFile 按
//   projectTrusted 门控)两个不可信注入面一并封死(P1 纪要遗留项)。
// - AGENTS.md(全局+项目两层,全部走 pi 原生上下文件通道):
//   全局层(引擎中立的家 pc-data/AGENTS.md,见 agents/global-agents.ts)经
//   agentsFilesOverride 以 virtual file 注入(SDK 官方宿主姿势,examples/sdk/
//   07-context-files.ts 同款)——渲染进 pi 原生 <project_context>/<project_instructions>
//   管线,与项目层同格式;上游对上下文件的任何改进(渲染/去重/权重)自动继承。
//   项目层走 pi 原生 loadProjectContextFiles(cwd 祖先链),同一 override 里做
//   词法过滤(越出工作区边界的祖先滤掉,提示词层与工具层同一边界纪律)。
//   排序:全局件 unshift 在 override 输出首位 = pi 原生 agentDir 全局件的既有序。
// - 人设+记忆:appendSystemPrompt 单一插槽(§3.4,只放我们自己的域:人设/记忆/
//   搜索指引/教学行/注入面),内容会话级冻结(见下)。
// - 扩展/prompt 模板/主题:v1 全关(noExtensions/noPromptTemplates/noThemes),
//   pi 的资源面只开技能与上下文文件两类。
//
// 冻结纪律(§4.8/§9.2):appendSystemPrompt 同会话内必须逐字节稳定;上下文件
// 在 ResourceLoader.reload 时点定格(每轮生成装配一次,用户编辑下轮生效——与
// 技能开关同语义)。
// - 人设:renderTemplate 含时间类模板变量,渲染结果按 会话+助手+原文指纹 冻结——
//   原文中途被改 → 指纹变 → 重渲染(与聊天引擎"改人设立即生效"同语义,破一次缓存);
//   原文不变 → 时间变量定格在首轮。
// - 记忆/最近会话:直接复用聊天引擎的 frozenContextBlocks(同一冻结生命周期与
//   失效面:设置页手动改记忆 → invalidateContextSnapshots → 两个引擎同时重建)。
// - 搜索指引/教学行:内容只随设置变(服务名/技能库路径),天然稳定。

import { mkdirSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { DefaultResourceLoader } from "../../pi/packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../pi/packages/coding-agent/src/core/settings-manager.ts";
import type { Assistant, Conversation, Model } from "../foundation/types";
import { getStringArray, renderTemplate } from "../foundation/utils";
import { piAgentDir, skillsDir, globalAgentsPath } from "../foundation/paths";
import { readGlobalAgentsFile } from "../agents/global-agents";
import { frozenContextBlocks } from "../inference-engine/context-snapshots";
import { PI_THINKING_BUDGETS } from "./model-bridge";
import { templateVariables } from "../inference-engine/message-enrichment";
import { buildSearchContext } from "../search";
import { reportError } from "../observability/app-errors";

export interface PiSessionResources {
  resourceLoader: DefaultResourceLoader;
  settingsManager: SettingsManager;
}

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
export function invalidatePiPersonaSnapshots(): void {
  personaSnapshots.clear();
}

// ---- appendSystemPrompt 组装 ----

/** 技能安装落点教学(§3.1:模型自装资源必须落到我们的家;<available_skills> 的
 *  location 自带自举,这行把"装新技能装到哪"说死)+ 审批语义披露(§3.4 安全披露:
 *  工具可能要用户批准,被拒就调整,别原样重试)。 */
function stableGuidanceLines(): string {
  const dir = skillsDir.replace(/\\/g, "/");
  return [
    `To install a new skill for the user, create \`${dir}/<skill-name>/SKILL.md\` (with name and description frontmatter). It becomes available once enabled in the app settings.`,
    "Some tool calls require explicit user approval before they run. A denied call returns an error with the reason — respect the decision and adjust your approach instead of retrying the same call.",
  ].join("\n");
}

/** pi 会话的 appendSystemPrompt 条目(有序;pi 侧以 \n\n join 追加在引擎 Guidelines 之后、
 *  <project_context> 之前,system-prompt.ts:165 实证)。分段各有恰当冻结源,拼接结果
 *  同会话内字节稳定。导出仅供测试断言冻结性。 */
export function buildPiAppendSystemPrompt(
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

// ---- 边界过滤 ----

/** 词法子树判定(与 workspace/approval.isLexicallyOutsideRoot 同前缀语义,Windows
 *  大小写不敏感)。AGENTS.md 过滤不碰 realpath:提示词层不执行任何东西,词法足够。 */
function isWithinRoot(path: string, root: string): boolean {
  const cmp = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const target = cmp(resolve(path));
  const rootCmp = cmp(resolve(root));
  return target === rootCmp || target.startsWith(rootCmp.endsWith(sep) ? rootCmp : rootCmp + sep);
}

// ---- diagnostics 上报(按内容键控:同一告警重复 reload 只报一次,内容变了复报) ----

const reportedDiagnostics = new Set<string>();

/** 技能开关/库路径变更后调用,让同一告警在新配置下重新评估是否上报。 */
export function invalidateReportedSkillDiagnostics(): void {
  reportedDiagnostics.clear();
}

// ---- 装配入口 ----

/** 每轮生成装配一次(与 createAgentSession 一次一会话同频)。技能清单/AGENTS.md 随
 *  装配时点定格(pi ResourceLoader 加载一次),会话中途改技能开关下轮生效——与聊天
 *  引擎 tools 逐轮重建同语义。 */
export async function createPiSessionResources(options: {
  conversation: Conversation;
  assistant: Assistant;
  model: Model;
  /** 会话工作目录(pi cwd,AGENTS.md 祖先链起点)。 */
  cwd: string;
  /** 工作区边界根(AGENTS.md 过滤基准)。 */
  root: string;
  /** P8 注入面统一:lorebook/模式注入的系统位文本(before/after_system_prompt),
   *  追加在人设/记忆之后、stableGuidanceLines 之前——与聊天引擎 systemParts 同位。 */
  extraAppendSystemPrompt?: string[];
  /** 压缩保留窗口覆盖(pi chars/4 估算口径)。手动压缩装配点传
   *  MANUAL_COMPACT_KEEP_RECENT_TOKENS(门槛/保留都调低,rationale 见 runner.ts 常量);
   *  不传 = pi 默认 20000(生成会话的 threshold/overflow 自动压缩用)。 */
  compactionKeepRecentTokens?: number;
}): Promise<PiSessionResources> {
  const { conversation, assistant, model, cwd, root, extraAppendSystemPrompt, compactionKeepRecentTokens } = options;
  // inMemory:零文件 I/O(不读不写任何 settings.json);projectTrusted:false 是给
  // resource-loader 的发现逻辑看的(.pi/SYSTEM.md 门控)。压缩面 P5 接管:threshold/
  // overflow 自动压缩显式开启(数值与 pi 默认一致,但不再依赖库默认值漂移),
  // reserveTokens/keepRecentTokens 取 pi 默认;重试等其余会话行为仍取 pi 默认值。
  // thinkingBudgets:Google 2.x 预算通道与聊天引擎同数值(model-bridge 四键投影,方言单源)。
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: {
        enabled: true,
        ...(compactionKeepRecentTokens != null ? { keepRecentTokens: compactionKeepRecentTokens } : {}),
      },
      thinkingBudgets: { ...PI_THINKING_BUDGETS },
    },
    { projectTrusted: false },
  );
  const enabledSkills = new Set(getStringArray(assistant.enabledSkills));
  // 技能库目录是我们的家,确保存在(与 tools/skills.listSkills 同款自愈)——否则冷启动
  // 未开过技能页时,pi 每轮 reload 都会对 additionalSkillPaths 报"path does not exist"。
  mkdirSync(skillsDir, { recursive: true });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: piAgentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noSkills: true,
    additionalSkillPaths: [skillsDir],
    skillsOverride: ({ skills, diagnostics }) => ({
      skills: skills.filter((skill) => skill.sourceInfo?.scope !== "project" && enabledSkills.has(skill.name)),
      diagnostics,
    }),
    agentsFilesOverride: ({ agentsFiles }) => {
      // 项目层:词法边界过滤(pi 默认 agentDir 全局件不在工作区内,天然被滤)。
      const project = agentsFiles.filter((file) => isAbsolute(file.path) && isWithinRoot(file.path, root));
      // 全局层:virtual file 注入首位(SDK 官方宿主姿势)——渲染走 pi 原生
      // <project_instructions> 管线,与项目层同格式;reload 时点定格,内容只在
      // 每轮生成装配时读(用户编辑下轮生效,与技能开关同语义)。
      const globalFile = readGlobalAgentsFile();
      return {
        agentsFiles: globalFile.exists
          ? [{ path: globalAgentsPath, content: globalFile.content }, ...project]
          : project,
      };
    },
    appendSystemPrompt: buildPiAppendSystemPrompt(conversation, assistant, model, extraAppendSystemPrompt),
  });
  // sdk 只对自建 loader 调 reload(sdk.ts:182-186),外部传入的必须自己加载。
  await resourceLoader.reload();

  // 技能校验告警面向用户在设置页内联展示(api/handlers/skills 的独立校验);这里只把
  // pi 实际加载时的诊断落进错误中心(warn),让"技能没被加载"有迹可循。
  for (const diagnostic of resourceLoader.getSkills().diagnostics) {
    const key = `${diagnostic.path ?? ""}|${diagnostic.message}`;
    if (reportedDiagnostics.has(key)) continue;
    reportedDiagnostics.add(key);
    reportError(
      "pi-engine",
      "warn",
      `技能资源诊断:${diagnostic.message}${diagnostic.path ? `(${diagnostic.path})` : ""}`,
      undefined,
      "pi_skill_diagnostic",
      { path: diagnostic.path ?? "", message: diagnostic.message },
    );
  }

  return { resourceLoader, settingsManager };
}
