// subprocess-engine/channel.ts — 主程序与引擎宿主进程之间的专用通道(P7.2.2,方案 §5.14.6、§5.14.13 修正②)
//
// 不走子进程的标准输出:插件能直接写 stdout,它起的命令也会继承 stdout,内容插进帧中间就再也对不齐。改用插件碰不到的
// 一条连接:Windows 是具名管道,Linux / mac 是 Unix 域套接字文件(node:net 对两者是同一套接口,差别只在路径)。
// - 路径(engineChannelPath):Windows `\\.\pipe\rikkahub-engine-<随机>-sock`;其余平台放进只有当前用户能进的目录
//   (Linux 优先 XDG_RUNTIME_DIR,否则在临时目录里新建一个 0700 目录),总长 Linux ≤ 107、mac ≤ 103,超了截短随机部分。
// - 令牌:主程序以随机名监听,令牌不放环境变量(会传给孙进程),由调用方经子进程 stdin 第一行交过去;子进程连上后第一帧
//   带令牌。只接受第一个令牌正确的连接,接受后立即关监听、删掉套接字文件;令牌不对或第一帧不对的连接直接断开。
// - 帧:frames.ts 的长度前缀。第一帧(问候)的其余字段(身份、协议版本、应用版本)由调用方核对。

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameDecoder, DEFAULT_MAX_FRAME_BYTES, encodeFrame } from "./frames";

const PIPE_PREFIX = "rikkahub-engine-";
/** sun_path 的可用长度(含结尾的 0 之前):Linux 108 - 1,mac 104 - 1。 */
const SOCKET_PATH_LIMIT: Partial<Record<NodeJS.Platform, number>> = { linux: 107, darwin: 103 };
const DEFAULT_SOCKET_PATH_LIMIT = 103;

/** 按平台取通道路径;baseDir 是放套接字文件的目录(Windows 不用)。纯函数,便于各平台在任一台机器上测。 */
export function engineChannelPath(platform: NodeJS.Platform, id: string, baseDir: string): string {
  if (platform === "win32") return `\\\\.\\pipe\\${PIPE_PREFIX}${id}-sock`;
  const sep = baseDir.endsWith("/") ? "" : "/";
  const fixed = `${baseDir}${sep}${PIPE_PREFIX}.sock`.length;
  const room = (SOCKET_PATH_LIMIT[platform] ?? DEFAULT_SOCKET_PATH_LIMIT) - fixed;
  if (room < 8) throw new Error(`引擎通道目录路径太长(${baseDir}),放不下套接字文件`);
  return `${baseDir}${sep}${PIPE_PREFIX}${id.slice(0, room)}.sock`;
}

/** 放套接字文件的目录:Linux 的 XDG_RUNTIME_DIR 本来只有当前用户能进;否则在临时目录里新建一个(mkdtemp 建的是 0700)。 */
function socketBaseDir(): { dir: string; owned: boolean } {
  const runtimeDir = process.platform === "linux" ? process.env.XDG_RUNTIME_DIR : undefined;
  if (runtimeDir) return { dir: runtimeDir, owned: false };
  return { dir: mkdtempSync(join(tmpdir(), "rkh-")), owned: true };
}

/** 一条按帧收发的连接。onFrame 设上之前到达的帧先排着,设上即按序交付。 */
export interface FrameChannel {
  send(text: string): void;
  onFrame(handler: (text: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  setMaxFrameBytes(limit: number): void;
  close(reason?: string): void;
}

function frameChannel(socket: Socket, decoderLimit = DEFAULT_MAX_FRAME_BYTES): FrameChannel & { once(handler: (text: string) => void): void } {
  let handler: ((text: string) => void) | null = null;
  const queued: string[] = [];
  let closeHandler: ((reason: string) => void) | null = null;
  let closedReason: string | null = null;
  const finish = (reason: string) => {
    if (closedReason !== null) return;
    closedReason = reason;
    closeHandler?.(reason);
  };
  const decoder = createFrameDecoder(
    (text) => (handler ? handler(text) : queued.push(text)),
    (reason) => {
      finish(reason);
      socket.destroy();
    },
    decoderLimit,
  );
  socket.on("data", (chunk: Buffer) => decoder.feed(chunk));
  socket.on("error", (err) => finish(`通道出错:${err.message}`));
  socket.on("close", () => finish("对端已断开"));
  const deliver = (next: (text: string) => void) => {
    handler = next;
    while (handler === next && queued.length > 0) next(queued.shift()!);
  };
  /** 只交付下一帧,之后的帧排着等 onFrame。 */
  const once = (next: (text: string) => void) => {
    const single = (text: string) => {
      handler = null;
      next(text);
    };
    deliver(single);
  };
  return {
    send(text) {
      if (closedReason === null) socket.write(encodeFrame(text));
    },
    onFrame: deliver,
    once,
    onClose(next) {
      closeHandler = next;
      if (closedReason !== null) next(closedReason);
    },
    setMaxFrameBytes: (limit) => decoder.setMaxFrameBytes(limit),
    close(reason = "本端关闭") {
      finish(reason);
      socket.end();
    },
  };
}

export interface ChannelHello {
  token: string;
  [field: string]: unknown;
}

export interface AcceptedChannel {
  channel: FrameChannel;
  /** 第一帧(已核对令牌),其余字段由调用方核对。 */
  hello: ChannelHello;
}

export interface EngineChannelListener {
  address: string;
  token: string;
  accepted: Promise<AcceptedChannel>;
  close(): void;
}

function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 主程序一侧:以随机名监听,等第一个令牌正确的连接。timeoutMs 内没等到即以错误拒绝并收起监听。 */
export async function listenEngineChannel(options: { timeoutMs?: number } = {}): Promise<EngineChannelListener> {
  const id = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const base = process.platform === "win32" ? null : socketBaseDir();
  const address = engineChannelPath(process.platform, id, base?.dir ?? "");
  const server: Server = createServer();
  const timeoutMs = options.timeoutMs ?? 15_000;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAccepted: (err: Error) => void = () => {};
  /** 连上了、还没发第一帧的连接;收起监听时一并断开。 */
  const waiting = new Set<Socket>();
  const cleanup = (keep?: Socket) => {
    clearTimeout(timer);
    for (const socket of waiting) if (socket !== keep) socket.destroy();
    waiting.clear();
    server.close();
    if (base?.owned) rmSync(base.dir, { recursive: true, force: true });
    else if (base) rmSync(address, { force: true });
  };

  const accepted = new Promise<AcceptedChannel>((resolve, reject) => {
    rejectAccepted = reject;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`引擎宿主进程 ${timeoutMs} ms 内没有连上通道`));
    }, timeoutMs);
    server.on("connection", (socket) => {
      if (settled) return void socket.destroy();
      waiting.add(socket);
      socket.once("close", () => waiting.delete(socket));
      const channel = frameChannel(socket);
      channel.once((text) => {
        let hello: unknown;
        try {
          hello = JSON.parse(text);
        } catch {
          // 第一帧不是 JSON:不是我们的子进程,断开即可
        }
        const record = typeof hello === "object" && hello !== null ? (hello as Record<string, unknown>) : null;
        if (settled || !record || !tokenMatches(token, record.token)) return void socket.destroy();
        settled = true;
        cleanup(socket);
        resolve({ channel, hello: record as ChannelHello });
      });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    settled = true;
    cleanup();
    throw err;
  }
  // 调用方总会等 accepted;这里先挂一个空处理,免得「没等到就收起」被当成未处理的拒绝
  accepted.catch(() => {});
  return {
    address,
    token,
    accepted,
    close() {
      if (settled) return;
      settled = true;
      cleanup();
      rejectAccepted(new Error("引擎通道的监听已收起"));
    },
  };
}

/** 宿主进程一侧:连上主程序给的地址,第一帧发问候(带令牌)。 */
export function connectEngineChannel(address: string, hello: ChannelHello): Promise<FrameChannel> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      const channel = frameChannel(socket);
      channel.send(JSON.stringify(hello));
      resolve(channel);
    });
  });
}
