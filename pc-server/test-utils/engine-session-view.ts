// test-utils/engine-session-view.ts — 中立消息序列 → 会话视图(测试夹具)
//
// 生产视图由 conversations/engine-session 组装(富化、摘要校验、原生条目挂载);引擎侧测试只需要
// 「一串中立消息 + 用户行的模型可见输入」,这里按同一形状给出,不带原生条目。

import type { EngineCompactionRecord, EngineSessionView } from "../engines/contract";
import type { Message, Model } from "../foundation/types";
import { userInputsFor } from "../inference-engine/prompt-input";

const IMAGE_CAPABLE = { modelId: "test-model", inputModalities: ["TEXT", "IMAGE"] } as unknown as Model;

export function sessionViewOf(
  history: Message[],
  options: { model?: Model; syntheticIds?: ReadonlySet<string>; compactions?: EngineCompactionRecord[] } = {},
): EngineSessionView {
  const inputs = userInputsFor(history, options.model ?? IMAGE_CAPABLE);
  return {
    items: history.map((message) => ({
      message,
      synthetic: options.syntheticIds?.has(message.id) ?? false,
      ...(inputs[message.id] ? { input: inputs[message.id] } : {}),
    })),
    compactions: options.compactions ?? [],
  };
}
