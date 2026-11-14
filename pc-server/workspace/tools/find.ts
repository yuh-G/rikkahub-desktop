// workspace/tools/find.ts — 纯 TS 的 glob 文件搜索(pi 内建 find 工具的自定义 glob 后端,见 pi-engine/builtin-tools.ts)
// pi 内建 find 默认调用外部程序 fd(ensureTool 会联网下载);应用不引入外部程序,改用 fs-walk 遍历器 + Bun.Glob
// (.gitignore 常用子集在遍历器内)。模式语义沿用 pi / fd(来源 packages/coding-agent/src/core/tools/find.ts v0.83.0,
// Adapted from pi, MIT © Mario Zechner):含 / 的模式全路径匹配并自动补 **/ 前缀,否则按 basename 任意深度匹配。

import { Glob } from "bun";
import { walkDirectory } from "./fs-walk";

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

/** 目录条目带尾 `/`,最多 limit 条。模式非法时抛错。 */
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
