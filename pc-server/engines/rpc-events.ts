// engines/rpc-events.ts — 跨进程传输里 host.emit 的整形与合并(P7.2.4,方案 §5.14.8)
//
// 整形:pi 的工具卡事件有两类带累计全文——tool_input_delta 的参数、命令执行中的输出快照(tool_result final:false),
// 终局 tool_call_created 还会把参数原样再带两遍。同进程传引用不要紧,跨进程每次都要整段转成文字。通道两端各留一份
// 同样的「每张卡上次的参数 / 输出」记录:宿主侧只发相对上次的后缀(参数没变就不带),应用侧拼回原事件,GenerationEvent
// 的语义与应用器都不变。两端的记录只随经过通道的事件按同一规则更新(编码后、解码后各 remember 一次),所以始终一致,
// 不另发同步消息;终局 tool_result 清掉那张卡的记录,超过上限按登记先后淘汰,两端淘汰的是同一条。执行中的输出超过
// pi 的保留上限后改为滚动保留尾部,新快照 = 上次快照去掉开头若干字 + 新增内容,这时只发去掉的字数与新增内容;
// 对不上的整份发。
//
// 合并(宿主侧):增量事件(正文、思考、参数、执行中的输出)约 16 ms 发一批,批内相邻的正文 / 思考拼接,同一张卡的
// 参数与输出快照只留最新;窗口外来的第一条立即发,首字不等。其余事件、以及这一端发出的任何其他消息,发出前都先把
// 这批发完(rpc-transport 的 beforeSend),同方向按序的保证不变。

import type { JsonValue, ToolOutputEntry } from "../foundation/types";
import type { GenerationEvent } from "../inference-engine/events";
import type { TurnRef } from "./contract";

/** 线上的 host.emit 事件:原事件,或带 append / sameInput 的缩写形态(只有本模块的解码器认)。 */
export type WireEmitEvent = { kind: string } & Record<string, unknown>;

/** 两端记录的卡数上限(正常情况下终局结果会清掉;中止、出错的卡靠它兜底)。 */
const MAX_CARD_RECORDS = 256;

interface CardRecord {
  input?: string;
  output?: string;
}

function toolCallIdOf(event: GenerationEvent): string | undefined {
  return "toolCallId" in event ? event.toolCallId : undefined;
}

/** 执行中的输出只有一段文本时取出它(pi 的快照与命令增量都是这个形状)。 */
function singleText(output: ToolOutputEntry[]): string | undefined {
  if (output.length !== 1) return undefined;
  const entry = output[0] as unknown;
  if (!entry || typeof entry !== "object") return undefined;
  const { type, text } = entry as { type?: unknown; text?: unknown };
  return type === "text" && typeof text === "string" ? text : undefined;
}

const extendsText = (prev: string | undefined, next: string): prev is string =>
  prev !== undefined && next.length >= prev.length && next.startsWith(prev);

const ROLL_PROBE_CHARS = 64;
const MAX_ROLL_CANDIDATES = 16;

/** 新快照能否写成 prev.slice(drop) + 后缀:返回 drop,对不上返回 undefined。用新快照开头一小段在旧快照里找候选位置,
 *  逐个核对(任何一个核对通过的位置都能逐字还原,不要求是「真实」的那个)。 */
function rollingDrop(prev: string, next: string): number | undefined {
  const probe = next.slice(0, ROLL_PROBE_CHARS);
  if (!probe) return undefined;
  let at = prev.indexOf(probe, 1);
  for (let tries = 0; at !== -1 && tries < MAX_ROLL_CANDIDATES; tries += 1) {
    if (prev.length - at <= next.length && next.startsWith(prev.slice(at))) return at;
    at = prev.indexOf(probe, at + 1);
  }
  return undefined;
}

class CardRecords {
  private readonly cards = new Map<string, CardRecord>();

  get(turn: TurnRef, event: GenerationEvent): CardRecord | undefined {
    const id = toolCallIdOf(event);
    return id === undefined ? undefined : this.cards.get(`${turn.turnId}\n${id}`);
  }

  remember(turn: TurnRef, event: GenerationEvent): void {
    const id = toolCallIdOf(event);
    if (id === undefined) return;
    const key = `${turn.turnId}\n${id}`;
    if (event.kind === "tool_result" && event.final !== false) {
      this.cards.delete(key);
      return;
    }
    if (event.kind !== "tool_call_created" && event.kind !== "tool_input_delta" && event.kind !== "tool_result") return;
    let record = this.cards.get(key);
    if (!record) {
      record = {};
      this.cards.set(key, record);
      if (this.cards.size > MAX_CARD_RECORDS) this.cards.delete(this.cards.keys().next().value!);
    }
    if (event.kind === "tool_result") record.output = singleText(event.output);
    // 已有卡上空参数的建卡事件不改参数(与应用器一致)。
    else if (event.kind === "tool_input_delta" || event.input || record.input === undefined) record.input = event.input;
  }
}

function shrink(record: CardRecord | undefined, event: GenerationEvent): WireEmitEvent {
  if (event.kind === "tool_input_delta" && extendsText(record?.input, event.input)) {
    return { kind: event.kind, toolCallId: event.toolCallId, append: event.input.slice(record!.input!.length) };
  }
  if (event.kind === "tool_call_created" && event.input && record?.input === event.input) {
    const { input: _input, ...rest } = event;
    return { ...rest, sameInput: true };
  }
  if (event.kind === "tool_result" && event.final === false) {
    const text = singleText(event.output);
    const prev = record?.output;
    if (text !== undefined && prev !== undefined) {
      const drop = extendsText(prev, text) ? 0 : rollingDrop(prev, text);
      if (drop !== undefined) {
        const { output, ...rest } = event;
        const entry = { ...(output[0] as Record<string, JsonValue>), text: "" };
        return { ...rest, ...(drop ? { drop } : {}), append: text.slice(prev.length - drop), entry };
      }
    }
  }
  return event;
}

function expand(record: CardRecord | undefined, wire: WireEmitEvent): GenerationEvent {
  if (wire.kind === "tool_input_delta" && typeof wire.append === "string") {
    if (record?.input === undefined) throw new Error(`工具卡 ${String(wire.toolCallId)} 的参数后缀没有前文`);
    return { kind: "tool_input_delta", toolCallId: String(wire.toolCallId), input: record.input + wire.append };
  }
  if (wire.kind === "tool_call_created" && wire.sameInput === true) {
    if (record?.input === undefined) throw new Error(`工具卡 ${String(wire.toolCallId)} 的参数没有前文`);
    const { sameInput: _sameInput, ...rest } = wire;
    return { ...rest, input: record.input } as GenerationEvent;
  }
  if (wire.kind === "tool_result" && typeof wire.append === "string") {
    if (record?.output === undefined) throw new Error(`工具卡 ${String(wire.toolCallId)} 的输出后缀没有前文`);
    const { append, entry, drop, ...rest } = wire;
    const kept = typeof drop === "number" ? record.output.slice(drop) : record.output;
    return { ...rest, output: [{ ...(entry as Record<string, JsonValue>), text: kept + append }] } as GenerationEvent;
  }
  return wire as GenerationEvent;
}

/** 宿主侧:原事件 → 线上形态。 */
export function createEmitEncoder(): (turn: TurnRef, event: GenerationEvent) => WireEmitEvent {
  const records = new CardRecords();
  return (turn, event) => {
    const wire = shrink(records.get(turn, event), event);
    records.remember(turn, event);
    return wire;
  };
}

/** 应用侧:线上形态 → 原事件。缩写找不到前文即抛(两端记录不一致,属于协议错误)。 */
export function createEmitDecoder(): (turn: TurnRef, wire: WireEmitEvent) => GenerationEvent {
  const records = new CardRecords();
  return (turn, wire) => {
    const event = expand(records.get(turn, wire as GenerationEvent), wire);
    records.remember(turn, event);
    return event;
  };
}

// ---- 合并 ----

/** 一批里最多攒多少条(正常 16 ms 内远到不了;到了就先发)。 */
const MAX_BATCH_EVENTS = 256;
const BATCH_WINDOW_MS = 16;

const isStreamingDelta = (event: GenerationEvent) =>
  event.kind === "text_delta"
  || event.kind === "reasoning_delta"
  || event.kind === "tool_input_delta"
  || (event.kind === "tool_result" && event.final === false);

/** 与批里最后一条合成一条;合不了返回 undefined。只合相邻的,事件间的先后不变。 */
function mergeAdjacent(prev: GenerationEvent, next: GenerationEvent): GenerationEvent | undefined {
  if (prev.kind === "text_delta" && next.kind === "text_delta") return { kind: "text_delta", text: prev.text + next.text };
  if (prev.kind === "reasoning_delta" && next.kind === "reasoning_delta" && !prev.metadata && !next.metadata) {
    return { kind: "reasoning_delta", text: prev.text + next.text };
  }
  // 参数与执行中的输出都是整体替换,同一张卡的相邻两条只留后一条。
  if (prev.kind === "tool_input_delta" && next.kind === "tool_input_delta" && prev.toolCallId === next.toolCallId) return next;
  if (
    prev.kind === "tool_result" && next.kind === "tool_result" && prev.final === false && next.final === false
    && prev.toolCallId === next.toolCallId && !prev.metadata
  ) {
    return next;
  }
  return undefined;
}

export type WireEmitBatch = Array<[TurnRef, WireEmitEvent]>;

export interface EmitCoalescer {
  emit(turn: TurnRef, event: GenerationEvent): void;
  /** 把攒着的这批立即发出(这一端要发任何其他消息之前调用)。 */
  flush(): void;
  close(): void;
}

/** 宿主侧:增量事件攒约 16 ms 一批(窗口外的第一条立即发),其余事件连同攒着的立即发。 */
export function createEmitCoalescer(sendBatch: (batch: WireEmitBatch) => void): EmitCoalescer {
  const encode = createEmitEncoder();
  let pending: Array<[TurnRef, GenerationEvent]> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function flush(): void {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    sendBatch(batch.map(([turn, event]) => [turn, encode(turn, event)]));
  }

  function tick(): void {
    timer = null;
    if (pending.length === 0) return;
    flush();
    timer = setTimeout(tick, BATCH_WINDOW_MS);
  }

  return {
    emit(turn, event) {
      if (closed) return;
      const last = pending.at(-1);
      const merged = last && last[0].turnId === turn.turnId ? mergeAdjacent(last[1], event) : undefined;
      if (merged) last![1] = merged;
      else pending.push([turn, event]);
      if (!isStreamingDelta(event)) {
        flush();
        return;
      }
      if (timer === null) {
        flush();
        timer = setTimeout(tick, BATCH_WINDOW_MS);
      } else if (pending.length >= MAX_BATCH_EVENTS) {
        flush();
      }
    },
    flush,
    close() {
      closed = true;
      pending = [];
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
