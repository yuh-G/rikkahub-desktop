// files/extraction.ts — 专题4:文档全文提取的子进程编排(父侧)+ worker 模式(子侧)
//
// 为什么是"用完即弃的子进程"而不是主进程内直接解析:
//   1. wasm 堆只涨不缩——mupdf 解析过一个大 PDF 后,主进程会永久占着峰值内存;
//      子进程退出即归还操作系统,主进程内存曲线与文档大小彻底解耦。
//   2. 崩溃隔离——损坏/恶意 PDF 把 wasm 打崩时只死子进程,服务器与用户会话无感。
//   3. 卡死可杀——解析卡住可以直接 kill,主进程里跑的同步 wasm 代码杀不掉。
//   4. 逐页进度——子进程 stdout 逐行上报 EXTRACT_PROGRESS,前端进度圆圈轮询消费。
//
// 单 exe 自孵化:经 foundation/process-roles 的 spawnSelf 以 extract-worker 身份启动本程序,入口在数据目录锁与
// 端口绑定之前就分流到 runExtractionWorker;任务参数(文件 id、路径、名字、类型)走环境变量。
//
// 纪律:本模块只管"怎么跑提取",解析器本体在 files/index.ts;不修改业务状态。

import { existsSync } from "node:fs";
import process from "node:process";
import { spawnSelf } from "../foundation/process-roles";
import type { StoredFile } from "../foundation/types";
import {
  extractStoredFileText,
  extractedTextPath,
  isExtractableDocument,
  writeExtractedTextSidecar,
} from "./index";

export type ExtractionState = "pending" | "done" | "empty" | "failed" | "none";

export interface ExtractionStatus {
  status: ExtractionState;
  /** PDF 逐页进度(其他格式解析快,没有中间进度,直接从 pending 跳到终态)。 */
  done: number | null;
  total: number | null;
}

// 逐 chunk 读子进程流。不用 `for await...of stream`:pi 0.84.2 升级把 @types/node 的
// undici-types 拉进编译图,其全局 ReadableStream(stream/web)遮蔽了 lib.dom.iterable 的
// 可迭代声明,Symbol.asyncIterator 在类型层丢失;显式 getReader() 与该全局声明之争无关。
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ── 父侧:任务登记簿 + 并发泵 ────────────────────────────────────────────────
//
// registry 语义(接替原 in-flight 去重 + R4-4 空结果负缓存,均为进程内、不落盘):
//   pending → 子进程在跑/在队列里;done → 旁车已写;empty → 提取过但没有文本
//   (扫描版 PDF 等,本次运行不再重试);failed → 子进程崩溃/超时/被杀(同样本次
//   运行不再重试——自动重试会在"必崩文件"上形成无限重生循环;重启或重新上传即重试)。
const registry = new Map<number, { status: "pending" | "done" | "empty" | "failed"; done?: number; total?: number }>();
const queue: StoredFile[] = [];
let activeCount = 0;
// 并发上限 2:提取是 CPU 密集活,再多只会互相抢核;多余任务排队保持 pending。
const MAX_CONCURRENT_EXTRACTIONS = 2;
// 停滞超时:无进度输出 5 分钟判死。用"停滞"而非绝对时长——万页大书只要每页都在
// 前进就不该被杀,真卡死(单页死循环)才需要收割。
const STALL_TIMEOUT_MS = 5 * 60_000;

/** 后台提取入口(3-4 的 ensureExtractedTextAsync 迁移至此,语义不变:调用即返回,
 *  结果写旁车缓存,本次请求方降级 fallbackDocumentText,下次发送生效)。 */
export function ensureExtractedTextAsync(entry: StoredFile): void {
  if (!isExtractableDocument(entry)) return;
  if (registry.has(entry.id)) return;
  if (existsSync(extractedTextPath(entry.id))) {
    registry.set(entry.id, { status: "done" });
    return;
  }
  registry.set(entry.id, { status: "pending" });
  queue.push(entry);
  pump();
}

/** 提取状态查询(files/:id/extraction 端点用)。重启后旁车缺失且无任务时自动重新
 *  拉起——轮询本身就是自愈触发器,上次没抽完就退出的文件不会永远停在"解析中"。 */
export function getExtractionStatus(entry: StoredFile): ExtractionStatus {
  if (!isExtractableDocument(entry)) return { status: "none", done: null, total: null };
  const current = registry.get(entry.id);
  if (current) {
    return { status: current.status, done: current.done ?? null, total: current.total ?? null };
  }
  if (existsSync(extractedTextPath(entry.id))) return { status: "done", done: null, total: null };
  ensureExtractedTextAsync(entry);
  return { status: "pending", done: null, total: null };
}

function pump(): void {
  while (activeCount < MAX_CONCURRENT_EXTRACTIONS && queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    activeCount += 1;
    void runExtractionChild(entry).finally(() => {
      activeCount -= 1;
      pump();
    });
  }
}

async function runExtractionChild(entry: StoredFile): Promise<void> {
  const t0 = Date.now();
  let result: "ok" | "empty" | null = null;
  try {
    const child = spawnSelf("extract-worker", {
      env: {
        ...process.env,
        RIKKAHUB_EXTRACT_FILE_ID: String(entry.id),
        RIKKAHUB_EXTRACT_PATH: entry.path,
        RIKKAHUB_EXTRACT_NAME: entry.fileName,
        RIKKAHUB_EXTRACT_MIME: entry.mime,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let killedForStall = false;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killedForStall = true;
        try { child.kill(); } catch { /* 已退出 */ }
      }, STALL_TIMEOUT_MS);
    };
    armStallTimer();

    // stderr 旁路收集(封顶 4KB),失败时给日志一个现场。
    let stderrText = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of streamChunks(child.stderr)) {
        if (stderrText.length < 4096) stderrText += decoder.decode(chunk, { stream: true });
      }
    })();

    const decoder = new TextDecoder();
    let lineBuffer = "";
    for await (const chunk of streamChunks(child.stdout)) {
      armStallTimer();
      lineBuffer += decoder.decode(chunk, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (line.startsWith("EXTRACT_PROGRESS ")) {
          const [doneRaw, totalRaw] = line.slice("EXTRACT_PROGRESS ".length).split(" ");
          const done = Number(doneRaw);
          const total = Number(totalRaw);
          if (Number.isFinite(done) && Number.isFinite(total)) {
            registry.set(entry.id, { status: "pending", done, total });
          }
        } else if (line.startsWith("EXTRACT_RESULT ")) {
          result = line.includes(" ok") ? "ok" : "empty";
        }
      }
    }
    const exitCode = await child.exited;
    if (stallTimer) clearTimeout(stallTimer);
    await stderrDone.catch(() => { /* stderr 读取失败不影响结果判定 */ });

    if (exitCode === 0 && result === "ok" && existsSync(extractedTextPath(entry.id))) {
      registry.set(entry.id, { status: "done" });
      console.log(`[extract] ${entry.fileName} done in ${Date.now() - t0}ms`);
    } else if (exitCode === 0 && result === "empty") {
      registry.set(entry.id, { status: "empty" });
      console.log(`[extract] ${entry.fileName} produced no text (scanned/unsupported)`);
    } else {
      registry.set(entry.id, { status: "failed" });
      const reason = killedForStall ? `stalled >${STALL_TIMEOUT_MS}ms, killed` : `exit ${exitCode}`;
      console.warn(`[extract] ${entry.fileName} failed (${reason}) ${stderrText.slice(0, 1000)}`);
    }
  } catch (err) {
    registry.set(entry.id, { status: "failed" });
    console.warn(`[extract] ${entry.fileName} spawn failed:`, err);
  }
}

// ── 子侧:worker 模式 ────────────────────────────────────────────────────────

/** 进程角色 extract-worker 的主体(入口 server.ts 分流后调用):执行单次提取,返回退出码。 */
export async function runExtractionWorker(): Promise<number> {
  const fileId = Number(process.env.RIKKAHUB_EXTRACT_FILE_ID);
  const entry: StoredFile = {
    id: fileId,
    path: process.env.RIKKAHUB_EXTRACT_PATH ?? "",
    fileName: process.env.RIKKAHUB_EXTRACT_NAME ?? "",
    mime: process.env.RIKKAHUB_EXTRACT_MIME ?? "application/octet-stream",
    size: 0,
  };
  try {
    if (!Number.isFinite(fileId) || !entry.path || !existsSync(entry.path)) {
      throw new Error(`invalid extraction task: id=${process.env.RIKKAHUB_EXTRACT_FILE_ID} path=${entry.path}`);
    }
    let lastPrintMs = 0;
    const text = await extractStoredFileText(entry, (done, total) => {
      // 逐页回调节流到 200ms:万页 PDF 也不至于用 stdout 刷爆父进程的行解析。
      const now = Date.now();
      if (done !== total && now - lastPrintMs < 200) return;
      lastPrintMs = now;
      console.log(`EXTRACT_PROGRESS ${done} ${total}`);
    });
    if (text) {
      writeExtractedTextSidecar(fileId, text);
      console.log(`EXTRACT_RESULT ok ${text.length}`);
    } else {
      console.log("EXTRACT_RESULT empty");
    }
  } catch (err) {
    console.error("[extract-worker] failed:", err);
    return 1;
  }
  return 0;
}
