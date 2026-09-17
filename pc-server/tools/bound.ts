// tools/bound.ts — 绑定当前全局 state 的工具聚合器（把 definitions 的纯函数与运行时设置绑定）
// 纪律：纯搬迁自 server.ts（阶段 5.3d），行为不变。不进 tools/index.ts barrel（与 core 同名）。

import type { Assistant, Model } from "../foundation/types";
import { shouldUseExternalWebSearch } from "../inference-engine/message-builder";
import { state } from "../persistence/json-store";
import {
  openAiLocalTools as openAiLocalToolsCore,
  openAiMcpTools as openAiMcpToolsCore,
  openAiSearchTools as openAiSearchToolsCore,
  openAiSkillTools as openAiSkillToolsCore,
} from "./definitions";
import { listSkills } from "./skills";

/** 外挂 search_web 的唯一注入源。带防双搜门控:模型已声明内置 search 时(自带
 *  googleSearch/web_search 服务端搜索),外挂让位不注入——判定走单源谓词
 *  shouldUseExternalWebSearch(对齐安卓),聊天/pi/未来引擎同口消费,无需各自复刻。
 *  model 缺省视为无内置搜索(pi 引擎不接内置搜索,可不传),维持"只看全局开关"旧行为。 */
export function openAiSearchTools(model?: Model | null) {
  return openAiSearchToolsCore(shouldUseExternalWebSearch(state.settings.enableWebSearch, model));
}

export function openAiSkillTools(assistant: Assistant) {
  return openAiSkillToolsCore(assistant, listSkills);
}

export function openAiLocalTools(assistant: Assistant) {
  return openAiLocalToolsCore(assistant, state.settings.memorySettings);
}

export function openAiMcpTools(assistant: Assistant) {
  return openAiMcpToolsCore(assistant, state.settings.mcpServers);
}

/** 会话级函数工具全集（M1-4）：四家装配点（orchestrator ×4 + conversation-encoding）
 *  的唯一聚合入口，消灭复读展开式。
 *  P6 退役:工作区工具条件挂载已移除——生成路由与旧挂载判定同用
 *  workspaceRuntimeForConversation,工作区可用必走 pi 会话(工具由
 *  pi-engine/workspace-tools 承载),不可用时旧挂载本就返回空,两头皆死代码。
 *  model 用于防双搜门控(见 openAiSearchTools):调用方在聊天引擎各装配点都能拿到
 *  picked.model/modelItem,务必传入以启用外挂让位;缺省则退化为只看全局开关。 */
export function conversationFunctionTools(assistant: Assistant, model?: Model | null) {
  return [
    ...openAiSearchTools(model),
    ...openAiLocalTools(assistant),
    ...openAiSkillTools(assistant),
    ...openAiMcpTools(assistant),
  ];
}
