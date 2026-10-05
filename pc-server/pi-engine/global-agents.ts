// pi-engine/global-agents.ts — 全局工作区指引(pi-agent/AGENTS.md,对齐 APP 2689e753
// 的 ~/.agents 层,PC 形态落在引擎的 agentDir——pi 原生 loadProjectContextFiles 把
// agentDir 直系上下文件排在项目文件之前,读取/优先级零适配)。
//
// 职责:文件读写 + 默认模板单一事实源 + 512KB 上限(与项目级 AGENTS.md 同限,
// workspace/files.ts)。消费端是 pi-engine/resources.ts 的边界过滤(agentDir 直系
// 放行)与设置页的编辑入口;chat 引擎无工作区概念,不消费本层。

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piAgentDir } from "../foundation/paths";

/** 候选名与 pi 的 loadContextFileFromDir 同序(首命中即实际加载;编辑入口读写
 *  "pi 眼中的那个文件",都不存在时新建标准名)。 */
const GLOBAL_CONTEXT_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

const GLOBAL_AGENTS_MAX_BYTES = 512 * 1024;

export const GLOBAL_AGENTS_TEMPLATE = `# AGENTS.md

Personal instructions for the AI agent, applied to every workspace session.

## Communication

- (Language, tone, formatting preferences...)

## Preferences

- (How you like the agent to approach tasks, ask questions, use tools...)

## Workflow

- (Recurring habits: run tests first, prefer specific tools, summarize before editing...)
`;

export interface GlobalAgentsFile {
  /** 实际存在的候选文件名;不存在时为将要创建的 "AGENTS.md"。 */
  fileName: string;
  exists: boolean;
  content: string;
  /** 供前端"新建"时预填的默认模板。 */
  template: string;
}

/** 目录参数化(对齐 json-store 的 *In 系列惯例):回归测试注入隔离目录,生产恒 piAgentDir。 */
function findGlobalContextFileIn(baseDir: string): string | null {
  for (const name of GLOBAL_CONTEXT_CANDIDATES) {
    try {
      if (statSync(join(baseDir, name)).isFile()) return name;
    } catch {
      // 不存在/不可读继续下一个候选
    }
  }
  return null;
}

export function readGlobalAgentsFileIn(baseDir: string): GlobalAgentsFile {
  const found = findGlobalContextFileIn(baseDir);
  if (!found) return { fileName: "AGENTS.md", exists: false, content: "", template: GLOBAL_AGENTS_TEMPLATE };
  return {
    fileName: found,
    exists: true,
    content: readFileSync(join(baseDir, found), "utf8"),
    template: GLOBAL_AGENTS_TEMPLATE,
  };
}

export function writeGlobalAgentsFileIn(baseDir: string, content: string): GlobalAgentsFile {
  if (Buffer.byteLength(content, "utf-8") > GLOBAL_AGENTS_MAX_BYTES) {
    throw new Error("AGENTS.md is too large (limit 512KB)");
  }
  // 写到 pi 实际加载的那个候选(已有 CLAUDE.md 就地编辑,不产生被遮蔽的第二份)。
  const fileName = findGlobalContextFileIn(baseDir) ?? "AGENTS.md";
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, fileName), content, "utf-8");
  return { fileName, exists: true, content, template: GLOBAL_AGENTS_TEMPLATE };
}

export function readGlobalAgentsFile(): GlobalAgentsFile {
  return readGlobalAgentsFileIn(piAgentDir);
}

export function writeGlobalAgentsFile(content: string): GlobalAgentsFile {
  return writeGlobalAgentsFileIn(piAgentDir, content);
}
