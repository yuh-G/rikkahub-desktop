// conversations/generation-state.ts — 会话生成中的运行时状态（AbortController 注册表）
// 单独成文件：api/sse 与编排层都要读它，独立后互不成环。

export const generating = new Map<string, AbortController>();

/** 中止意图(对齐 Codex TurnAbortReason::{Interrupted, Replaced}):谁中止谁声明,收尾按它
 *  决定队列命运,不再靠事后看注册表猜「是被接管还是被打断」——那种推断在 OCR 续体等异步
 *  窗口里会判反(旧流的 catch 抢在新流登记前跑到,把接管误判成打断并冻结队列)。
 *  - interrupted:用户主动停止(stop 端点)。停止意图支配队列:排队消息不接棒点火,冻结等
 *    显式 resume(Codex on_thread_idle 对 Interrupted 直接 return)。
 *  - replaced:被新的写入口接管(send/regenerate/edit/compress/generateAnswer 入口不变式)。
 *    新流代表用户继续对话的意图,收尾时队列照常派发(Codex 新输入开 turn 后 Completed 续跑)。
 *  - deleted:会话被删除。队列随会话一并清除,收尾不派发。 */
export type GenerationAbortReason = "interrupted" | "replaced" | "deleted";

/** 携带意图的中止信号。继承 DOMException(name=AbortError):现有按 name 判中止的路径
 *  (fetch reject / reader 轮询 / pi runner)零改动照常识别;Bun 的 fetch 会把 signal.reason
 *  原对象 reject 出来,子类身份保留。 */
export class GenerationAborted extends DOMException {
  constructor(readonly reason: GenerationAbortReason) {
    super(`Generation ${reason}`, "AbortError");
  }
}

/** 中止会话在跑的生成并声明意图;无在跑生成返回 false。只中止,不动 generating 登记——
 *  登记的清除/接管由调用方按自身语义处理(stop 端点清、写入口由新流 set 顶替)。 */
export function abortGeneration(conversationId: string, reason: GenerationAbortReason): boolean {
  const controller = generating.get(conversationId);
  if (!controller) return false;
  controller.abort(new GenerationAborted(reason));
  return true;
}

/** 读取中止信号上的意图;非本模块发出的中止(无 reason / 外部 AbortError)返回 null。 */
export function abortReasonOf(signal: AbortSignal): GenerationAbortReason | null {
  return signal.reason instanceof GenerationAborted ? signal.reason.reason : null;
}

/** 压缩进行中的会话 → 开始时刻(epoch ms;服务端权威;内测反馈:切页后压缩状态丢失)。
 *  compress 端点开始/结束时维护,SSE 连接建立时据此补发 engine-status 快照(含
 *  startedAt,"已处理 xx秒"计时跨重连连续)——engine-status 帧本身是瞬态语义(重连
 *  即重置),没有这份快照,切页回来状态条就永远空着,用户误以为压缩被取消(实际
 *  SPA 内切路由不断 fetch,压缩照常跑完)。 */
export const compressing = new Map<string, number>();

/** 域4-1(专题-交互审查 2A):审批等待中的会话 → {开始时刻, 工具名, 审批对象摘要}。
 *  与 compressing 同哲学:engine-status 帧是瞬态语义(重连即重置),审批挂起可能跨
 *  切页/失焦存活很久,没有这份注册表,SSE 重连后"等待审批"的琥珀态就丢失、桌面
 *  通知也无从恢复。由 approval-flow.gateToolApproval 在进入/离开等待时维护;
 *  生成终局(finally busy:false)兜底清除。一个会话同时只挂一张审批卡(sequential),
 *  故单值而非集合。 */
export const awaitingApproval = new Map<string, { startedAt: number; toolName?: string; summary?: string }>();
