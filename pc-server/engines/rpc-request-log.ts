// engines/rpc-request-log.ts — 跨进程传输里 host.models.log 的请求正文差分(P7.2.4,方案 §5.14.8)
//
// 请求日志要留正文(日志页点开显示),所以每次请求的正文都得交回主程序;同一会话相邻两次请求的正文大部分相同
// (整段上下文 + 新的一两条),300 轮的会话每次约 1.4 MB。通道两端各记每个会话上一次的正文:宿主侧只发「保留前多少
// 字、后多少字,中间换成什么」,应用侧拼回完整正文。两端的记录只随经过通道的日志按同一规则更新,淘汰也按同一顺序,
// 所以始终一致。没有前文(宿主进程刚启动、会话第一次请求)时整份发。

import type { ModelRequestRecord, TurnRef } from "./contract";

export type WireRequestRecord = Omit<ModelRequestRecord, "requestBody"> & {
  requestBody?: string;
  /** 相对同一会话上一次正文的差分:保留前 keepHead 字与后 keepTail 字,中间换成 insert。 */
  bodyDiff?: { keepHead: number; keepTail: number; insert: string };
};

const MAX_REMEMBERED_CONVERSATIONS = 8;
/** 比这短的正文不做差分(省下的不够付记录的内存)。 */
const MIN_DIFF_CHARS = 4096;
const BLOCK = 4096;

function commonPrefix(a: string, b: string, limit: number): number {
  let i = 0;
  while (i + BLOCK <= limit && a.slice(i, i + BLOCK) === b.slice(i, i + BLOCK)) i += BLOCK;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function commonSuffix(a: string, b: string, limit: number): number {
  let n = 0;
  while (n + BLOCK <= limit && a.slice(a.length - n - BLOCK, a.length - n) === b.slice(b.length - n - BLOCK, b.length - n)) n += BLOCK;
  while (n < limit && a.charCodeAt(a.length - n - 1) === b.charCodeAt(b.length - n - 1)) n += 1;
  return n;
}

class LastBodies {
  private readonly bodies = new Map<string, string>();

  get(conversationId: string): string | undefined {
    return this.bodies.get(conversationId);
  }

  remember(conversationId: string, body: string | undefined): void {
    this.bodies.delete(conversationId);
    if (body === undefined || body.length < MIN_DIFF_CHARS) return;
    this.bodies.set(conversationId, body);
    if (this.bodies.size > MAX_REMEMBERED_CONVERSATIONS) this.bodies.delete(this.bodies.keys().next().value!);
  }
}

/** 宿主侧:原记录 → 线上形态。 */
export function createRequestLogEncoder(): (turn: TurnRef, record: ModelRequestRecord) => WireRequestRecord {
  const last = new LastBodies();
  return (turn, record) => {
    const body = record.requestBody;
    const prev = last.get(turn.conversationId);
    last.remember(turn.conversationId, body);
    if (body === undefined || prev === undefined) return record;
    const limit = Math.min(prev.length, body.length);
    const keepHead = commonPrefix(prev, body, limit);
    const keepTail = commonSuffix(prev, body, limit - keepHead);
    const insert = body.slice(keepHead, body.length - keepTail);
    if (insert.length >= body.length / 2) return record;
    const { requestBody: _requestBody, ...rest } = record;
    return { ...rest, bodyDiff: { keepHead, keepTail, insert } };
  };
}

/** 应用侧:线上形态 → 原记录。差分找不到前文即抛(两端记录不一致,属于协议错误)。 */
export function createRequestLogDecoder(): (turn: TurnRef, wire: WireRequestRecord) => ModelRequestRecord {
  const last = new LastBodies();
  return (turn, wire) => {
    const { bodyDiff, ...rest } = wire;
    let record: ModelRequestRecord = rest;
    if (bodyDiff) {
      const prev = last.get(turn.conversationId);
      if (prev === undefined || bodyDiff.keepHead + bodyDiff.keepTail > prev.length) {
        last.remember(turn.conversationId, undefined);
        throw new Error(`会话 ${turn.conversationId} 的请求正文差分没有前文`);
      }
      record = { ...rest, requestBody: prev.slice(0, bodyDiff.keepHead) + bodyDiff.insert + prev.slice(prev.length - bodyDiff.keepTail) };
    }
    last.remember(turn.conversationId, record.requestBody);
    return record;
  };
}
