// pi-engine/resources.test.ts — P4 资源装配的统一管理不变式
//
// 钉住方案 §三 的四条硬边界:
//   1) 技能:唯一技能库 + enabledSkills 白名单;工作区 .pi/skills 项目技能永不加载;
//   2) AGENTS.md:工作区边界内的才进提示词,祖先链/agentDir 全局件被滤;
//   3) 注入面:.pi/settings.json 与 .pi/SYSTEM.md 全部失效(inMemory + projectTrusted:false);
//   4) appendSystemPrompt 冻结:含时间模板变量的人设同会话字节稳定,人设原文变更立即生效。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-piresources-test-"));

const { skillsDir, piAgentDir, dataDir } = await import("../foundation/paths");
const { buildPiAppendSystemPrompt, createPiSessionResources, invalidatePiPersonaSnapshots } = await import("./resources");
const { defaultAssistant } = await import("../assistants");
const { defaultState } = await import("../app-config/defaults");
const { setState, state } = await import("../persistence/json-store");

import type { Assistant, Conversation, Model, State } from "../foundation/types";

const priorState = state;
setState(defaultState() as State);
afterAll(() => {
  setState(priorState);
  invalidatePiPersonaSnapshots();
});

function makeSkill(root: string, dirName: string, frontmatter: string): void {
  mkdirSync(join(root, dirName), { recursive: true });
  writeFileSync(join(root, dirName, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`, "utf-8");
}

const fakeModel = { id: "m1", modelId: "fake", displayName: "Fake" } as unknown as Model;

let seq = 0;
function fixture(options: { enabledSkills?: string[]; systemPrompt?: string; conversationPrompt?: string | null } = {}) {
  seq += 1;
  const assistant: Assistant = {
    ...defaultAssistant(),
    id: `res-a-${seq}`,
    enabledSkills: options.enabledSkills ?? [],
    systemPrompt: options.systemPrompt ?? "",
  };
  const conversation = {
    id: `res-c-${seq}`,
    assistantId: assistant.id,
    systemPrompt: options.conversationPrompt ?? null,
    title: "资源测试",
    messages: [],
  } as unknown as Conversation;
  return { assistant, conversation };
}

describe("P4 资源装配", () => {
  test("技能面:白名单生效,工作区 .pi/skills 项目技能与未启用技能都不加载", async () => {
    makeSkill(skillsDir, "alpha-skill", 'name: alpha-skill\ndescription: Alpha skill');
    makeSkill(skillsDir, "beta-skill", 'name: beta-skill\ndescription: Beta skill');
    const root = mkdtempSync(join(tmpdir(), "rkh-res-ws-"));
    makeSkill(join(root, ".pi", "skills"), "evil-skill", 'name: evil-skill\ndescription: Project-scoped skill must never load');

    const { assistant, conversation } = fixture({ enabledSkills: ["alpha-skill"] });
    const { resourceLoader } = await createPiSessionResources({ conversation, assistant, model: fakeModel, cwd: root, root });
    const names = resourceLoader.getSkills().skills.map((skill) => skill.name);
    expect(names).toEqual(["alpha-skill"]);
  });

  test("AGENTS.md 面:全局层经原生上下文件通道注入(首位),项目层按边界过滤,客房文件忽略", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rkh-res-agents-"));
    const root = join(parent, "ws");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(parent, "AGENTS.md"), "ANCESTOR-INSTRUCTIONS", "utf-8");
    writeFileSync(join(root, "AGENTS.md"), "WORKSPACE-INSTRUCTIONS", "utf-8");
    // 全局层:pc-data/AGENTS.md(引擎中立,本测试数据目录直系)。写进 pi-agent/ 的
    // 任何文件都必须被忽略——客房纯空置,agentDir 直系件天然被边界过滤。
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(join(piAgentDir, "AGENTS.md"), "STALE-AGENTDIR-GLOBAL", "utf-8");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "AGENTS.md"), "GLOBAL-INSTRUCTIONS", "utf-8");

    const { assistant, conversation } = fixture();
    const { resourceLoader } = await createPiSessionResources({ conversation, assistant, model: fakeModel, cwd: root, root });
    const files = resourceLoader.getAgentsFiles().agentsFiles;
    // 全局 virtual file 在首位(与 pi 原生 agentDir 全局件的序一致),项目面只剩 root 内的
    expect(files.map((file) => file.content)).toEqual(["GLOBAL-INSTRUCTIONS", "WORKSPACE-INSTRUCTIONS"]);
    expect(files[0]!.path).toContain("AGENTS.md");
    // 走原生通道:不占 appendSystemPrompt 插槽(那里只放我们自己的域:人设/记忆/教学)
    const append = resourceLoader.getAppendSystemPrompt().join("\n\n");
    expect(append).not.toContain("GLOBAL-INSTRUCTIONS");
    expect(append).not.toContain("STALE-AGENTDIR-GLOBAL");
    // 清扫本测试在共享路径上的落笔:客房目录必须回到不存在(model-bridge 的零落盘
    // 断言看整个目录;Bun 单进程跑全部文件,这里不删就会跨文件污染)。
    rmSync(piAgentDir, { recursive: true, force: true });
    rmSync(join(dataDir, "AGENTS.md"), { force: true });
  });

  test("全局层未创建时:上下文件只含项目面,不注入空占位", async () => {
    const root = mkdtempSync(join(tmpdir(), "rkh-res-agents-none-"));
    writeFileSync(join(root, "AGENTS.md"), "WORKSPACE-INSTRUCTIONS", "utf-8");
    const { assistant, conversation } = fixture();
    const { resourceLoader } = await createPiSessionResources({ conversation, assistant, model: fakeModel, cwd: root, root });
    expect(resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual(["WORKSPACE-INSTRUCTIONS"]);
  });

  test("注入面封死:.pi/settings.json 不被读取,.pi/SYSTEM.md 不接管系统提示词", async () => {
    const root = mkdtempSync(join(tmpdir(), "rkh-res-inject-"));
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ defaultModel: "attacker-model", defaultProvider: "attacker" }), "utf-8");
    writeFileSync(join(root, ".pi", "SYSTEM.md"), "HIJACKED SYSTEM PROMPT", "utf-8");

    const { assistant, conversation } = fixture();
    const { resourceLoader, settingsManager } = await createPiSessionResources({ conversation, assistant, model: fakeModel, cwd: root, root });
    expect(settingsManager.getDefaultModel()).toBeUndefined();
    expect(settingsManager.isProjectTrusted()).toBe(false);
    // systemPrompt 未被项目文件接管 → pi 走内建默认(loader 返回 undefined)。
    expect(resourceLoader.getSystemPrompt()).toBeUndefined();
    expect(resourceLoader.getAppendSystemPrompt().join("\n")).not.toContain("HIJACKED");
  });

  test("appendSystemPrompt 冻结:时间模板变量同会话字节稳定;人设原文变更立即生效", async () => {
    const { assistant, conversation } = fixture({ systemPrompt: "You are {{char}}. Now: {{cur_datetime}}" });
    const first = buildPiAppendSystemPrompt(conversation, assistant, fakeModel);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = buildPiAppendSystemPrompt(conversation, assistant, fakeModel);
    expect(second).toEqual(first);
    expect(first.join("\n")).not.toContain("{{cur_datetime}}"); // 变量确实被渲染过

    // 原文变更 → 指纹换 → 重渲染(与聊天引擎"改人设立即生效"同语义)。
    const edited: Assistant = { ...assistant, systemPrompt: "You are someone else entirely." };
    const third = buildPiAppendSystemPrompt(conversation, edited, fakeModel);
    expect(third.join("\n")).toContain("someone else entirely");
  });

  test("appendSystemPrompt 内容面:含技能安装教学与审批披露,会话级人设按开关覆盖", async () => {
    const base = fixture({ systemPrompt: "assistant-persona", conversationPrompt: "conversation-persona" });
    // 开关关(默认):助手人设生效,会话级被忽略——与聊天引擎 effectiveSystemPrompt 同规则。
    const closed = buildPiAppendSystemPrompt(base.conversation, base.assistant, fakeModel).join("\n\n");
    expect(closed).toContain("assistant-persona");
    expect(closed).not.toContain("conversation-persona");
    expect(closed).toContain("To install a new skill");
    expect(closed).toContain("require explicit user approval");
    // 开关开:会话级覆盖助手人设。
    const allowed = { ...base.assistant, allowConversationSystemPrompt: true };
    const open = buildPiAppendSystemPrompt(base.conversation, allowed, fakeModel).join("\n\n");
    expect(open).toContain("conversation-persona");
    expect(open).not.toContain("assistant-persona");
  });

  test("坏技能诊断经 loader 暴露(description 缺失,pi 拒绝加载)", async () => {
    makeSkill(skillsDir, "broken-skill", "name: broken-skill");
    const root = mkdtempSync(join(tmpdir(), "rkh-res-diag-"));
    const { assistant, conversation } = fixture({ enabledSkills: ["broken-skill"] });
    const { resourceLoader } = await createPiSessionResources({ conversation, assistant, model: fakeModel, cwd: root, root });
    expect(resourceLoader.getSkills().skills).toEqual([]);
    expect(resourceLoader.getSkills().diagnostics.some((d) => d.message.includes("description is required"))).toBe(true);
  });
});
