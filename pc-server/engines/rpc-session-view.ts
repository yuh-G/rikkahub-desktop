// engines/rpc-session-view.ts — 跨进程传输里 host.session.load 的指纹对账(P7.2.4,方案 §5.14.8)
//
// 会话视图每轮整份交付(引擎每轮自己对比,编辑 / 重新生成 / 切分支不用另外通知);同进程传引用,跨进程每轮要把整段
// 会话转成文字(300 轮约 2.7 MB)。对账保留「每轮整份交付」的语义,只是不重复传宿主侧已有的条目:
// 1. 宿主侧发请求时带上自己缓存的这个会话的条目指纹;
// 2. 应用侧把每一条转成 JSON 文本、算指纹,按顺序回全部指纹,只附上宿主侧没有的条目文本;
// 3. 宿主侧用缓存加新条目拼回完整视图,缓存换成这一轮的条目。
// 指纹对「要传的那份文本」本身算,文本不同指纹就不同。宿主进程刚启动、被回收、崩溃重启后缓存是空的,该会话第一轮
// 整份传。宿主侧每次都从文本解析出新对象交给驱动,与整份传时一样,驱动改了拿到的对象也影响不到下一轮。

import type { EngineSessionItem, EngineSessionView } from "./contract";

/** 线上的会话视图:按顺序的全部指纹,宿主侧缺的条目附 JSON 文本。 */
export interface WireSessionView {
  order: string[];
  items: Record<string, string>;
  compactions: EngineSessionView["compactions"];
}

/** sha256 截取前 128 位(32 个十六进制字符):每条几十字节,碰撞概率可以不计。 */
export function sessionItemFingerprint(json: string): string {
  return new Bun.CryptoHasher("sha256").update(json).digest("hex").slice(0, 32);
}

/** 应用侧:整份视图 → 线上形态。have = 宿主侧已缓存的指纹。 */
export function shrinkSessionView(view: EngineSessionView, have: readonly string[]): WireSessionView {
  const known = new Set(have);
  const order: string[] = [];
  const items: Record<string, string> = {};
  for (const item of view.items) {
    const json = JSON.stringify(item);
    const fingerprint = sessionItemFingerprint(json);
    order.push(fingerprint);
    if (!known.has(fingerprint)) items[fingerprint] = json;
  }
  return { order, items, compactions: view.compactions };
}

/** 宿主侧缓存的总字符数上限;超出按最久没用的会话淘汰(正在用的那个会话总是留着)。 */
const MAX_CACHED_CHARS = 16 * 1024 * 1024;
const MAX_CACHED_CONVERSATIONS = 32;

type CachedView = Map<string, string>;

function sizeOf(view: CachedView): number {
  let chars = 0;
  for (const json of view.values()) chars += json.length;
  return chars;
}

/** 宿主侧:每个会话上一轮的条目文本(按指纹)。 */
export class SessionViewCache {
  private readonly views = new Map<string, { view: CachedView; chars: number }>();
  private totalChars = 0;

  /** 发请求时取一份快照:回包里没附文本的条目从它取(同一会话的两次 load 并发时,后一次换掉缓存也不影响前一次)。 */
  snapshot(conversationId: string): CachedView {
    return this.views.get(conversationId)?.view ?? new Map();
  }

  rebuild(conversationId: string, snapshot: CachedView, wire: WireSessionView): EngineSessionView {
    const next: CachedView = new Map();
    const items: EngineSessionItem[] = [];
    for (const fingerprint of wire.order) {
      const json = Object.hasOwn(wire.items, fingerprint) ? wire.items[fingerprint] : snapshot.get(fingerprint);
      if (json === undefined) throw new Error(`会话视图对账失败:条目 ${fingerprint} 既不在回包里也不在缓存里`);
      next.set(fingerprint, json);
      items.push(JSON.parse(json) as EngineSessionItem);
    }
    this.store(conversationId, next);
    return { items, compactions: wire.compactions };
  }

  drop(conversationId: string): void {
    const entry = this.views.get(conversationId);
    if (!entry) return;
    this.views.delete(conversationId);
    this.totalChars -= entry.chars;
  }

  private store(conversationId: string, view: CachedView): void {
    this.drop(conversationId);
    const chars = sizeOf(view);
    this.views.set(conversationId, { view, chars });
    this.totalChars += chars;
    for (const [id, entry] of this.views) {
      if (this.views.size <= 1 || (this.totalChars <= MAX_CACHED_CHARS && this.views.size <= MAX_CACHED_CONVERSATIONS)) break;
      if (id === conversationId) continue;
      this.views.delete(id);
      this.totalChars -= entry.chars;
    }
  }
}
