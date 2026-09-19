// foundation/types/android-contract.ts — 安卓跨端契约判别符「单一事实源」。
//
// 背景(两起真实事故,见 backup/android-contract-sync.test.ts 头注):
//   ① custom_js 曾被误判 PC-only 过滤——其实它是安卓正式类型(人工核对看错模块);
//   ② PC 的 loading 占位 part 未过滤,导出到安卓 = 会话打不开。
// 结论:兼容性判定不能靠"开发新功能时惦记着"。本模块把「安卓认识哪些判别符」收敛成
// 唯一权威来源,两类消费方共享同一份,杜绝口径分叉:
//   - 同步哨兵(backup/android-contract-sync.test.ts):本机有安卓参考仓时,把这些清单
//     直接和 Kotlin 源码里的 @SerialName 比对,腐化即红——清单的可信度由它保证;
//   - 导出降级(backup/export.ts):凡不在清单内的判别符一律降级/过滤,绝不让未知值硬发
//     给旧版 APP(那是"会话打不开"事故的来源)。
//
// ⚠️ 这些清单是"vendored 快照",会随安卓版本演进。要改它们,先更新安卓参考仓,再让
// android-contract-sync.test.ts 的同步层来核对——别手改清单去迁就测试。
//
// 归置说明:消息 part / 注解的「PC 全集」由各自类型文件就近维护(PC_MESSAGE_PART_TYPES /
// PC_MESSAGE_ANNOTATION_TYPES,带编译期双向断言),本模块不重复;TTS 的 PC 全集单源在
// media/tts-providers/registry.ts(TTS_PROVIDER_TYPES,由注册表键推导);ASR 的「本端认识」
// 集单源在 foundation/types/index.ts(PC_KNOWN_ASR_TYPES,此处中转再导出供媒体/契约两处消费)。
// 本模块只承载一类新数据:安卓判别符全集(vendored,供哨兵核对 + 导出降级共用)。

export { PC_KNOWN_ASR_TYPES } from "./index";

// ── 安卓判别符全集(vendored,以安卓参考仓 Kotlin 源码 @SerialName 为准)────────────
// 来源模块(2026-09-19 复核;同步层据此定位 Kotlin 文件):
// - search/src/main/java/me/rerere/search/SearchService.kt   sealed SearchServiceOptions
// - ai/src/main/java/me/rerere/ai/ui/UIMessagePart.kt        sealed UIMessagePart
// - ai/src/main/java/me/rerere/ai/ui/UIMessageAnnotation.kt  sealed UIMessageAnnotation
// - speech/.../tts/provider/TTSProviderSetting.kt            sealed TTSProviderSetting
// - speech/.../asr/ASRProviderSetting.kt                     sealed ASRProviderSetting

export const ANDROID_SEARCH_SERVICE_TYPES: ReadonlySet<string> = new Set([
  "bing_local", "zhipu", "tavily", "exa", "searxng", "linkup", "brave", "metaso", "ollama",
  "perplexity", "firecrawl", "jina", "bocha", "rikkahub", "grok", "tinyfish", "serper", "custom_js",
  "doubao",
]);

/** 安卓 UIMessagePart 全判别符。含已 @Deprecated 但仍在 sealed 集合内的 search/tool_call/
 *  tool_result(仍会被反序列化接受),以及 2.5.x ai 模块重构新增的 server_tool
 *  (UIMessagePart.kt:168)——之前 vendored 漏了它,正是「哨兵沉睡」事故的直接证据。 */
export const ANDROID_MESSAGE_PART_TYPES: ReadonlySet<string> = new Set([
  "text", "image", "video", "audio", "document", "reasoning",
  "search", "tool_call", "tool_result", "tool", "server_tool",
]);

export const ANDROID_ANNOTATION_TYPES: ReadonlySet<string> = new Set(["url_citation"]);

export const ANDROID_TTS_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "openai", "gemini", "system", "minimax", "qwen", "groq", "xai", "mimo",
  "elevenlabs", "step", "fish-audio", "volcengine",
]);

export const ANDROID_ASR_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "openai_realtime", "dashscope", "volcengine", "mimo", "step",
]);
