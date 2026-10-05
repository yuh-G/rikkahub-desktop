// agents/global-agents.ts — 全局工作区指引(pc-data/AGENTS.md,引擎中立)
//
// 用户亲写的、对所有工作区会话生效的个人指令层(对齐 APP 2689e753 的 ~/.agents 层)。
// 家在 pc-data/AGENTS.md——与 skills/、memory/ 平级的应用级资源,不属于任何引擎:
// pi 引擎经 appendSystemPrompt 注入本层(resources.ts,内容只读),未来引擎直接
// import 本模块同源消费。候选名序与 pi 的 loadContextFileFromDir 同构(首命中即
// 生效;编辑入口读写"实际生效的那个文件",都不存在时新建标准名)。

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalAgentsPath } from "../foundation/paths";
import { reportError } from "../observability/app-errors";

/** 候选名清单(pi resource-loader.loadContextFileFromDir 同序,AGENTS.override.md
 *  除外——那是 pi 的手动遮蔽机制,不是用户编辑入口的读写对象)。 */
export const GLOBAL_AGENTS_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

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

/** 目录参数化(对齐 json-store 的 *In 系列惯例):回归测试注入隔离目录,生产恒 dataDir。 */
function findGlobalContextFileIn(baseDir: string): string | null {
  for (const name of GLOBAL_AGENTS_CANDIDATES) {
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
  try {
    return {
      fileName: found,
      exists: true,
      content: readFileSync(join(baseDir, found), "utf8"),
      template: GLOBAL_AGENTS_TEMPLATE,
    };
  } catch (err) {
    // 候选存在但读不出(Windows 反病毒在用户刚保存后扫描写关闭文件的 EBUSY/EPERM,与
    // state.json 读失败三分类同类)。本函数在每轮工作区生成装配时被调,把异常上抛会让
    // 每一轮生成都打成错误横幅——按"文件不存在"降级(该轮不注入全局层,锁释放后下轮
    // 自愈),对齐 APP 2689e753 的静默跳过语义,但按 P2-1 纪律留错误中心记录。
    reportError(
      "workspace",
      "warn",
      "全局工作区指引读取失败，本轮工作区会话不注入（下轮自动重试）",
      err,
      "global_agents_read_failed",
      { path: join(baseDir, found) },
    );
    return { fileName: found, exists: false, content: "", template: GLOBAL_AGENTS_TEMPLATE };
  }
}

export function writeGlobalAgentsFileIn(baseDir: string, content: string): GlobalAgentsFile {
  if (Buffer.byteLength(content, "utf-8") > GLOBAL_AGENTS_MAX_BYTES) {
    throw new Error("AGENTS.md is too large (limit 512KB)");
  }
  // 写到实际生效的那个候选(已有 CLAUDE.md 就地编辑,不产生被遮蔽的第二份)。
  const fileName = findGlobalContextFileIn(baseDir) ?? "AGENTS.md";
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, fileName), content, "utf-8");
  return { fileName, exists: true, content, template: GLOBAL_AGENTS_TEMPLATE };
}

/** 生产读:pc-data/ 直系。 */
export function readGlobalAgentsFile(): GlobalAgentsFile {
  return readGlobalAgentsFileIn(dirname(globalAgentsPath));
}

export function writeGlobalAgentsFile(content: string): GlobalAgentsFile {
  return writeGlobalAgentsFileIn(dirname(globalAgentsPath), content);
}
