// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/find.ts(v0.83.0)。schema/description 与
// 模式语义(含 / 的模式全路径匹配并自动补 **/ 前缀,否则按 basename)逐字保留。
// PC 适配:pi 默认 shell 出 fd 二进制(ensureTool 联网下载);兜底场景(无 bash 的机器)
// 不引入外部二进制,引擎换 fs-walk 遍历器 + Bun.Glob(.gitignore 常用子集在遍历器内)。
// 挂载策略(2026-08-01):仅在 bash 不可用时挂载。

import { pathExists, resolveToCwd } from "./path-utils";
import { walkDirectory } from "./fs-walk";
import { Glob } from "bun";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate";
import type { WorkspaceToolDefinition } from "./types";

export interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
  visitCapReached?: boolean;
}

/**
 * Pluggable operations for the find tool.
 * PC:边界校验层从这里注入。
 */
export interface FindOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
}

const defaultFindOperations: FindOperations = {
  exists: pathExists,
};

export interface FindToolOptions {
  /** Custom operations for find. Default: local filesystem */
  operations?: FindOperations;
}

const FIND_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    },
    path: { type: "string", description: "Directory to search in (default: current directory)" },
    limit: { type: "number", description: "Maximum number of results (default: 1000)" },
  },
  required: ["pattern"],
} as const;

// pi/fd 语义:模式含 / 时全路径匹配(缺通配前缀时自动补全);否则按 basename 任意深度匹配。
// 全路径模式保留原样与补前缀两个 glob,任一命中即命中(`**` 零层匹配语义保险)。
function compileFindPattern(pattern: string): { globs: Glob[]; fullPath: boolean } {
  if (pattern.includes("/")) {
    const effective = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    const variants = [effective];
    if (!effective.startsWith("**/") && effective !== "**") {
      variants.push(`**/${effective}`);
    }
    return { globs: variants.map((v) => new Glob(v)), fullPath: true };
  }
  return { globs: [new Glob(pattern)], fullPath: false };
}

/** 纯 TS 的 glob 搜索(fs-walk 遍历 + Bun.Glob):目录条目带尾 `/`,最多 limit 条。pi 内建 find 的自定义
 *  glob 后端也用它(pi-engine/builtin-tools.ts),不依赖外部程序 fd。模式非法时抛错。 */
export function collectFindMatches(
  pattern: string,
  searchPath: string,
  limit: number,
  signal?: AbortSignal,
): { matches: string[]; visitCapReached: boolean } {
  let compiled: { globs: Glob[]; fullPath: boolean };
  try {
    compiled = compileFindPattern(pattern);
  } catch {
    throw new Error(`Invalid glob pattern: ${pattern}`);
  }
  const matches: string[] = [];
  const walk = walkDirectory(searchPath, {
    signal,
    includeDirectories: true,
    onEntry({ relativePath, isDirectory }) {
      const target = compiled.fullPath ? relativePath : (relativePath.split("/").pop() ?? relativePath);
      if (!compiled.globs.some((g) => g.match(target))) return;
      matches.push(isDirectory ? `${relativePath}/` : relativePath);
      if (matches.length >= limit) return false;
    },
  });
  return { matches, visitCapReached: walk.visitCapReached };
}

export function createFindTool(
  cwd: string,
  options?: FindToolOptions,
): WorkspaceToolDefinition<FindToolInput, FindToolDetails | undefined> {
  const ops = options?.operations ?? defaultFindOperations;
  return {
    name: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: FIND_SCHEMA as unknown as Record<string, unknown>,
    async execute({ pattern, path: searchDir, limit }, signal?) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      if (!(await ops.exists(searchPath))) {
        throw new Error(`Path not found: ${searchPath}`);
      }

      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
      const { matches, visitCapReached } = collectFindMatches(pattern, searchPath, effectiveLimit, signal);
      const walk = { visitCapReached };

      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
      }

      const resultLimitReached = matches.length >= effectiveLimit;
      const rawOutput = matches.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let resultOutput = truncation.content;
      const details: FindToolDetails = {};
      const notices: string[] = [];
      if (resultLimitReached) {
        notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.resultLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (walk.visitCapReached && !resultLimitReached) {
        notices.push("Directory tree too large, search stopped early. Narrow the path argument");
        details.visitCapReached = true;
      }
      if (notices.length > 0) {
        resultOutput += `\n\n[${notices.join(". ")}]`;
      }
      return {
        content: [{ type: "text", text: resultOutput }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}
