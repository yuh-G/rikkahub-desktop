// subprocess-engine/index.ts — 子进程引擎骨架的公共出口(T4)。
//
// 四个模块各司其职,组合成一条完整管线:
//   process.ts   拉起子进程 + 管住生死(spawn/杀树/退出分类/stderr 摘录)
//   protocol.ts  stdout 字节流 → 行帧 → JSON-RPC 消息(增量、背压、防卫上限)
//   bridge.ts    协议消息 → GenerationEvent 的翻译基座(映射由 adapter 注入)
//   errors.ts    子进程死亡分类与归因文案(参照 classifyProxyError 哲学)
//
// 进程内引擎(chat/pi)与子进程引擎(dsh/codex/claude-code)共享同一输出契约
// GenerationEvent,差异只在"事件从哪来"。本骨架把"从子进程来"这一半收敛成
// 可复用层,接 dsh 时 dsh-engine/ 的驱动只需:注入 map(协议消息→事件)+ 登记进
// engines/index 的驱动数组,不碰这里。

export { spawnSubprocess, runSubprocessToExit } from "./process";
export type { SpawnSubprocessOptions, SubprocessHandle } from "./process";

export { createLineFramer, parseJsonRpcLine, MAX_LINE_BYTES } from "./protocol";
export type { FrameYield, JsonRpcMessage, JsonRpcErrorObject, ParseOutcome } from "./protocol";

export { startSubprocessBridge } from "./bridge";
export type {
  SubprocessEventMapper,
  StartBridgeOptions,
  SubprocessBridgeSession,
} from "./bridge";

export { classifySpawnError, classifyExit, describeExit } from "./errors";
export type { SubprocessExitKind, SubprocessExitInfo } from "./errors";
