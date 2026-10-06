// engines/transport-guard.test.ts — LLM 请求通道的**源码扫描卫兵**(T6,替代散文约定)。
//
// T 阶段把「引擎往 globalThis.fetch 上叠猴补丁 + 靠 ALS 猜请求归属」收敛成两层:
// 进程基础设施(net.ts 唯一一层全局壳)在下,引擎级关注点(日志/预热/将来插件)走
// LLM 请求通道(inference-engine/llm-transport)的有序中间件。本卫兵把这条架构边界
// 落成可执行规则,防止回退到散落的全局壳或绕过通道的裸 fetch。
//
// 两条源码规则(方案 §6 T6 的 ①②;为不重复断言,去掉原计划的 ③):
//   ① **全局 fetch 只允许 net.ts 安装**——任何新文件 `globalThis.fetch = …` 即红。
//      唯一白名单是 pi google 轨的日志兜底壳(pi google 适配器拒收自定义 fetch,只能
//      用窄全局壳补记日志),带明确拆除条件;上游支持注入后本卫兵应随之收紧。
//   ② **pi-engine/ 与 engines/ 内禁止裸 `fetch(`**——引擎唯一 LLM 出口是组装点下发的
//      `ctx.llmFetchFor(provider)`,不是全局 fetch;裸调即绕过通道(无日志/无预热/
//      不受统一身份管理)。
//
// 新引擎接入的第三条规则「每个注册 adapter 必须声明 transport」是**行为断言**,已在
// engines/llm-middlewares.test.ts「注册表契约」用例里锁死(带 requestLog 合法性 +
// pi/chat 事实对照)。此处不再复写同一断言,保持单一来源。
//
// 扫描纪律(同 api/sse-headers-guard.test.ts):只扫**生产** .ts(排除 *.test.ts 与
// scripts/ 冒烟脚本——测试与冒烟本就该能替换全局 fetch 造场景);先剥注释再匹配,
// 故文档里出现的 `globalThis.fetch =` 不算违规。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 仓库 pc-server 根(本文件在 engines/ 下)。 */
const PC_SERVER_ROOT = join(import.meta.dir, "..");

/** 递归收集生产 .ts(排除测试、依赖、运行时数据、构建产物、冒烟脚本)。 */
function productionTsFiles(dir: string, excludeTop: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "pc-data", "dist", ".output", ...excludeTop].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionTsFiles(full, excludeTop));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** 相对 pc-server 根的 POSIX 路径(供白名单比对,跨平台稳定)。 */
function relPosix(file: string): string {
  return relative(PC_SERVER_ROOT, file).split(sep).join("/");
}

/** 剥掉块注释与行注释——匹配的是活代码,文档里写的禁忌字样不算违规。
 *  `(?<![:\w])` 前置守卫避开 `https://` 里被当成行注释的 `//`(URL 中的 `//` 前是冒号)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<![:\w])\/\/[^\n]*/g, "");
}

const ALL_FILES = productionTsFiles(PC_SERVER_ROOT, ["scripts"]);

describe("LLM 请求通道卫兵(T6)", () => {
  test("全仓生产代码只允许 net.ts 在 globalThis.fetch 上安装(引擎级关注点走通道中间件)", () => {
    // 白名单:pi google 轨的窄日志兜底壳。pi 的 google 适配器拒收自定义 fetch(方案 §2.3 P5),
    // 其请求不经通道,只能用一层窄全局壳补记日志以保住排障面。
    // **拆除条件**:pi 上游支持注入 fetch 后删除(CLAUDE.md pi 维护手册「清除冗余」已登记)——
    // 届时删掉本白名单项,规则自动收紧到「只有 net.ts」。
    const allowlist = new Set(["foundation/net.ts", "pi-engine/llm-request-log.ts"]);
    // 覆盖两种常见写法(点号与方括号);`(?!==)` 使 `==`/`===` 比较不算赋值。
    // 这是给「诚实的手滑」设的绊线,不是防蓄意绕过——合理写法都能命中,
    // 蓄意规避(先存 globalThis 引用再赋值)不在源码扫描能覆盖的范畴。
    const assignment = /globalThis\s*(?:\.\s*fetch|\[\s*["']fetch["']\s*\])\s*=(?!=)/;
    const offenders = ALL_FILES.filter((file) => {
      if (allowlist.has(relPosix(file))) return false;
      return assignment.test(stripComments(readFileSync(file, "utf8")));
    }).map(relPosix);
    expect(offenders).toEqual([]);
  });

  test("pi-engine/ 与 engines/ 内不得裸 fetch(必须走 ctx.llmFetchFor 下发的通道)", () => {
    const engineFiles = [...productionTsFiles(join(PC_SERVER_ROOT, "pi-engine"), []), ...productionTsFiles(join(PC_SERVER_ROOT, "engines"), [])];
    // 裸 fetch 调用:`fetch(` 且前一字符不是 `.`(排除 obj.fetch(、ctx.llmFetchFor( 等成员访问)
    // 与标识符字符(排除 prefetch( / llmFetch( 之类的词尾)。
    const bareFetch = /(?<![.\w$])fetch\s*\(/;
    const offenders = engineFiles.filter((file) => bareFetch.test(stripComments(readFileSync(file, "utf8")))).map(relPosix);
    expect(offenders).toEqual([]);
  });
});
