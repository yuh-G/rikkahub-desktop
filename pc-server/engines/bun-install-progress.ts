// engines/bun-install-progress.ts — 从 bun add 的终端进度条读出阶段与计数(插件安装的进度环用)。
//
// bun 只在输出是终端时画进度条,管道下只在最后打一行总结,所以要进度的安装经伪终端跑(Bun.spawn 的 terminal 选项,
// Windows 上是 ConPTY)。进度条原地重画,每帧是「图标 + 名字 + [已完成/总数]」:下载段的名字是正在取的包,总数边解析
// 边涨;安装段的名字固定是 Installing。ConPTY 会改写光标控制(行尾清除、光标定位、用光标右移代替空格),所以 SGR 颜色
// 直接去掉、光标右移当空格、其余控制序列当作帧的分界,再按回车 / 换行切。

export type BunInstallPhase = "download" | "install";

export interface BunInstallProgress {
  phase: BunInstallPhase;
  done: number;
  total: number;
  /** 下载段正在取的包。 */
  item?: string;
}

/** 两次上报的最小间隔;换阶段立即报。bun 每秒重画几十次,不节流会把事件通道打满。 */
export const PROGRESS_MIN_INTERVAL_MS = 100;

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[([0-9;?]*)[ -/]*([@-~])/g;
const FRAME = /^(.*?)\s*\[(\d+)\/(\d+)\]$/;
const COUNTER = /\[?\d+\/\d+\]/;
// 帧名字前的图标(🔍 🚚 📦 ⚙️ 之类)与空白。
const LEADING_SYMBOLS = /^[^\p{L}\p{N}@]+/u;

function normalize(text: string): string {
  return text.replace(OSC, "").replace(CSI, (_match, _params: string, final: string) => (final === "m" ? "" : final === "C" ? " " : "\r"));
}

export interface BunProgressReader {
  /** 喂一段终端输出(已解码的文本)。 */
  push(text: string): void;
  /** 非进度条的输出行(报错用),末尾最多 maxChars 个字符。 */
  outputTail(maxChars: number): string;
}

export function createBunProgressReader(
  onProgress: (progress: BunInstallProgress) => void,
  options: { now?: () => number; minIntervalMs?: number } = {},
): BunProgressReader {
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  let pending = "";
  let phase: BunInstallPhase | null = null;
  let lastEmit = -Infinity;
  const lines: string[] = [];

  const frame = (name: string, done: number, total: number) => {
    const next: BunInstallPhase = name === "Installing" ? "install" : "download";
    // 只前进:进入安装段后别的进度条(依赖的安装脚本)不算下载。
    if (phase === "install" && next === "download") return;
    // 开头那帧「Resolving [1/1]」只是占位,还没开始取包。
    if (next === "download" && (name === "Resolving" || total <= 1)) return;
    const changed = next !== phase;
    const at = now();
    if (!changed && at - lastEmit < minInterval) return;
    phase = next;
    lastEmit = at;
    onProgress(next === "download" ? { phase: next, done, total, item: name.slice(0, 80) } : { phase: next, done, total });
  };

  const segment = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const match = FRAME.exec(text);
    if (match) {
      frame(match[1]!.replace(LEADING_SYMBOLS, "").trim(), Number(match[2]), Number(match[3]));
      return;
    }
    // 只重画了一部分的进度帧(ConPTY 偶尔只发变了的字符)不算输出。
    if (COUNTER.test(text)) return;
    lines.push(text);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };

  return {
    push(text) {
      pending += text;
      // 控制序列可能被切在两段之间:只处理到最后一个回车 / 换行,剩下的等下一段。
      const cut = Math.max(pending.lastIndexOf("\r"), pending.lastIndexOf("\n"));
      if (cut < 0) return;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut + 1);
      for (const part of normalize(ready).split(/[\r\n]+/)) segment(part);
    },
    outputTail(maxChars) {
      const rest = normalize(pending).split(/[\r\n]+/);
      const all = [...lines];
      for (const part of rest) {
        const text = part.trim();
        if (text && !COUNTER.test(text)) all.push(text);
      }
      return all.join("\n").slice(-maxChars);
    },
  };
}
