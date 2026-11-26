// subprocess-engine/frames.ts — 引擎宿主通道的帧:4 字节长度(大端无符号)+ UTF-8 JSON 文本(P7.2.2,方案 §5.14.6)
//
// 取代行帧(protocol.ts 的 createLineFramer:单行上限 1 MiB、每来一块都从头找换行)。长度前缀不找分隔符:
// 解码器把收到的块排成队列,凑够长度头就知道要等多少字节,凑够了只拷贝这一帧的字节,剩下的是原块的视图——
// 每个字节只拷贝一次,大帧分成多少块到达都是线性的。单帧上限在握手时协商,超出即判协议违例(防失控的对端撑爆内存)。

/** 握手前与默认的单帧上限。 */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 4;

export function encodeFrame(text: string): Buffer {
  const length = Buffer.byteLength(text, "utf8");
  const out = Buffer.allocUnsafe(HEADER_BYTES + length);
  out.writeUInt32BE(length, 0);
  out.write(text, HEADER_BYTES, "utf8");
  return out;
}

export interface FrameDecoder {
  feed(chunk: Uint8Array): void;
  setMaxFrameBytes(limit: number): void;
  readonly violated: boolean;
  /** 已收到、尚未成帧的字节数。 */
  readonly buffered: number;
}

export function createFrameDecoder(
  onFrame: (text: string) => void,
  onViolation: (reason: string) => void,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): FrameDecoder {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let chunks: Buffer[] = [];
  let buffered = 0;
  /** 当前帧正文的长度;-1 表示还没读到长度头。 */
  let need = -1;
  let violated = false;
  let limit = maxFrameBytes;

  function take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const head = chunks[0]!;
    buffered -= n;
    if (head.length >= n) {
      if (head.length === n) chunks.shift();
      else chunks[0] = head.subarray(n);
      return head.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const first = chunks[0]!;
      const count = Math.min(first.length, n - offset);
      first.copy(out, offset, 0, count);
      offset += count;
      if (count === first.length) chunks.shift();
      else chunks[0] = first.subarray(count);
    }
    return out;
  }

  function fail(reason: string): void {
    violated = true;
    chunks = [];
    buffered = 0;
    onViolation(reason);
  }

  return {
    feed(chunk) {
      if (violated || chunk.byteLength === 0) return;
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      buffered += chunk.byteLength;
      while (!violated) {
        if (need < 0) {
          if (buffered < HEADER_BYTES) return;
          need = take(HEADER_BYTES).readUInt32BE(0);
          if (need > limit) return fail(`帧长 ${need} 字节超过上限 ${limit},判定协议违例`);
        }
        if (buffered < need) return;
        const body = take(need);
        need = -1;
        let text: string;
        try {
          text = decoder.decode(body);
        } catch {
          return fail("帧正文不是合法的 UTF-8,判定协议违例");
        }
        onFrame(text);
      }
    },
    setMaxFrameBytes(next) {
      limit = next;
    },
    get violated() {
      return violated;
    },
    get buffered() {
      return buffered;
    },
  };
}
