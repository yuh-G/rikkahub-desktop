// bun-install-progress.test.ts — 从伪终端里的 bun add 输出读阶段与计数。样本取自 Windows ConPTY 下 bun 1.4.2 的原始输出。
import { describe, expect, test } from "bun:test";

import { type BunInstallProgress, createBunProgressReader } from "./bun-install-progress";

const START = "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b[1mbun add \x1b[22m\x1b[2mv1.4.2 (744846f84)\x1b[22m\r\n";
const RESOLVE =
  "  🔍 Resolving [1/1] \r  🔍 @modelcontextprotocol/sdk [12/27]\x1b[K\x1b[1C\r  🔍 es-define-property [22/62]\x1b[K\x1b[1C\r" +
  "  🚚 es-define-property [111/261]\x1b[K\x1b[1C\r";
const INSTALL = "  📦 Installing [6/210] \r  📦 Installing [8/210]\x1b[K\x1b[1C\r  📦 Installing [210/210]\x1b[K\x1b[1C\r";

function read(chunks: string[], minIntervalMs = 0) {
  const seen: BunInstallProgress[] = [];
  const reader = createBunProgressReader((progress) => seen.push(progress), { minIntervalMs, now: () => 0 });
  for (const chunk of chunks) reader.push(chunk);
  return { seen, reader };
}

describe("bun 安装进度", () => {
  test("下载段带正在取的包与边涨的总数,安装段只有计数;开头的 Resolving [1/1] 不算", () => {
    const { seen } = read([START, RESOLVE, INSTALL]);
    expect(seen).toEqual([
      { phase: "download", done: 12, total: 27, item: "@modelcontextprotocol/sdk" },
      { phase: "download", done: 22, total: 62, item: "es-define-property" },
      { phase: "download", done: 111, total: 261, item: "es-define-property" },
      { phase: "install", done: 6, total: 210 },
      { phase: "install", done: 8, total: 210 },
      { phase: "install", done: 210, total: 210 },
    ]);
  });

  test("控制序列切在两段之间也认得出", () => {
    const whole = START + RESOLVE + INSTALL;
    const pieces: string[] = [];
    for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7));
    expect(read(pieces).seen).toEqual(read([whole]).seen);
  });

  test("同一段里按间隔节流,换段立即报;进入安装段后不再回到下载段", () => {
    const { seen } = read([RESOLVE, INSTALL, "  🔍 late-package [3/9]\r"], 1000);
    expect(seen).toEqual([
      { phase: "download", done: 12, total: 27, item: "@modelcontextprotocol/sdk" },
      { phase: "install", done: 6, total: 210 },
    ]);
  });

  test("报错用的输出不含进度帧", () => {
    const { reader } = read([
      START,
      "  🔍 Resolving [1/1] \r  🔍 zz-no-such-pkg [2/1]\rerror: GET https://registry.example/zz-no-such-pkg - 404\r\n",
      "\x1b[?25h\x1b[?9001l\x1b[?1004l",
    ]);
    expect(reader.outputTail(2000)).toBe("bun add v1.4.2 (744846f84)\nerror: GET https://registry.example/zz-no-such-pkg - 404");
  });
});
