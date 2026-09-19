// api/handlers/conversations.ts — 会话路由（stream、batch-delete、列表/分页/搜索、单会话子路由）
// 纪律：纯搬迁自 server.ts routeApi()；生成编排（generateAnswer 等）仍在 server.ts，经导入使用。

import type { Conversation, ConversationSnapshotEventDto, ConversationSnapshotMetaEventDto, EngineStatusEventDto, JsonValue, MessageNode, MessagePart } from "../../foundation/types";
import type { ConversationListDto, ConversationNodesPageDto, MessageSearchResultDto, PagedResult } from "../../foundation/types";
import { applyPlaceholders, id, message, textFromParts } from "../../foundation/utils";
import { CodedError } from "../../foundation/errors";
import { state } from "../../persistence/json-store";
import {
  getConversation,
  persistConversation,
  toListDto,
  toMessageNodeDtos,
  truncateConversationForRegenerate,
} from "../../conversations";
import { getConversationsDb } from "../../conversations";
import { checkoutConversation, registerConversation, releaseConversation } from "../../conversations/working-set";
import { searchMessageFts } from "../../conversations/fts";
import { listConversationMetas, pagedConversationMetas } from "../../conversations/read-queries";
import { applyInputRegexTransformParts } from "../../assistants/index";
import { findModel } from "../../model-providers/index";
import { error, json, readJson } from "../request";
import { conversationNegotiationToken } from "../snapshot-negotiation";
import { nodeStamp, SNAPSHOT_NODE_WINDOW, toSnapshotConversationDto } from "../snapshot-window";
import {
  broadcastConversation,
  broadcastEngineStatus,
  broadcastList,
  broadcastNodeUpdate,
  conversationClients,
  openSse,
} from "../sse";
import { bumpAnalyticsMsgCount } from "../../app-config/analytics";
import { DEFAULT_TRANSLATION_PROMPT } from "../../app-config/prompts";
import { attachOcrToImageParts, compressConversation, conversationModelIdFor, englishLanguageName, fetchAuxiliaryText, generateTitleForConversation, isQwenMtModel, markOcrPendingParts, modelExists, resolveFastModelId } from "../../conversations/auxiliary";
import { compactEngineConversation, dispatchMessageQueue, generateAnswer, resolveEngineForConversation } from "../../conversations/orchestrator";
import { deleteConversationsById, ensureConversation, findAssistant, finishInterruptedPendingToolsInConversation, hasPendingToolApproval } from "../../conversations/helpers";
import { editQueuedMessage, enqueueMessage, holdMessageQueue, pauseMessageQueue, releaseMessageQueueHold, removeQueuedMessage, resumeMessageQueue, waitForQueuedReply } from "../../conversations/message-queue";
import { pushSteeringMessage, removeSteeringMessage } from "../../conversations/steering-channel";
import { awaitingApproval, compressing, generating } from "../../conversations/generation-state";
import { getWorkspace } from "../../workspace";
import { resolveToolApproval } from "../../inference-engine/approval-gate";

export async function handleConversationRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  // 列表失效事件已并入 /api/events 通道(invalidate 事件);会话详情流保持独立端点
  // (conversations/<id>/stream)——它随切换重建,不占常驻预算的额外名额。
  if (path === "conversations/batch-delete" && request.method === "POST") {
    const body = await readJson<{ ids?: string[] }>(request);
    const ids = new Set((body.ids ?? []).map(String).filter(Boolean));
    if (ids.size === 0) return error("No conversations selected", 400);
    deleteConversationsById(ids);
    return json({ status: "deleted", deleted: ids.size });
  }

  // DB-first 批1:列表读直查活库元数据(SQL 只做 WHERE+基准排序,过滤/排序/分页留在 JS
  // 逐字复刻旧内存实现——SQLite lower()/LIKE 只处理 ASCII,与 JS toLowerCase 语义有差异)。
  // 流式期间 updateAt 最多滞后 200ms(脏标记节流),列表场景不可感知。db 不可用时降级空列表
  // (活库彻底损坏场景,会话功能整体不可用,与 search 端点既有降级一致)。
  if (path === "conversations" && request.method === "GET") {
    const db = getConversationsDb();
    const metas = db ? listConversationMetas(db, state.settings.assistantId) : [];
    // 侧边栏绿灯在生成或压缩中都点亮(内测拍板:压缩也是会话忙碌,全局视野要可见;
    // 绿点样式/文案不区分两态,就是原来的绿灯)。detail/快照面的 isGenerating 不掺
    // 压缩——那是"停止生成"按钮的语义,压缩取消走压缩框自己的通道。
    return json(metas.map((item) => toListDto(item, generating.has(item.id) || compressing.has(item.id))));
  }
  // J 族(专题2):排序+分页全在 SQL 侧(复合索引扫描,O(页大小)),不再把该助手全部
  // 元数据读入 JS——数千会话时列表刷新与 invalidate 风暴的单次成本与总量解耦。
  // 旧 query 过滤参数是死代码(前端标题/内容搜索走 conversations/search 的 FTS 端点,
  // 全仓无调用方),随本次清理移除。offset/limit 在 API 边界收敛为非负整数(SQL 绑定
  // 不接受 NaN/负数;旧实现靠 slice 的宽容语义兜着)。
  if (path === "conversations/paged" && request.method === "GET") {
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    const rawLimit = Number(url.searchParams.get("limit") ?? "20");
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20;
    const db = getConversationsDb();
    const { items, total } = db
      ? pagedConversationMetas(db, state.settings.assistantId, offset, limit)
      : { items: [], total: 0 };
    const paged: PagedResult<ConversationListDto> = {
      items: items.map((item) => toListDto(item, generating.has(item.id) || compressing.has(item.id))),
      nextOffset: offset + limit < total ? offset + limit : null,
      hasMore: offset + limit < total,
    };
    return json(paged);
  }
  if (path === "conversations/search" && request.method === "GET") {
    // P1-2：FTS5 trigram 索引查询（旧实现为全会话×全消息内存线性扫描，见 conversations/fts.ts）。
    // 流式期间内存领先活库最多 200ms（脏节点节流 flush），搜索"正在生成中的最后一句"可能
    // 晚 200ms 命中——可接受（搜索场景极少针对正在生成的内容）。
    const queryText = (url.searchParams.get("query") ?? "").trim();
    const db = getConversationsDb();
    if (!queryText || !db) return json([]);
    // DB-first 批1:title/updateAt join 改用活库元数据(原为 state.conversations 内存 map)
    const byId = new Map(listConversationMetas(db, state.settings.assistantId).map((meta) => [meta.id, meta]));
    const results = searchMessageFts(db, queryText)
      .flatMap((hit): MessageSearchResultDto[] => {
        const conversation = byId.get(hit.conversationId);
        // 当前助手过滤（响应契约不变）；已删会话的残留命中防御性跳过
        if (!conversation || conversation.assistantId !== state.settings.assistantId) return [];
        return [{ nodeId: hit.nodeId, messageId: hit.messageId, conversationId: hit.conversationId, title: conversation.title, updateAt: conversation.updateAt, snippet: hit.snippet }];
      })
      .sort((a, b) => b.updateAt - a.updateAt);
    return json(results);
  }

  const conversationStream = path.match(/^conversations\/([^/]+)\/stream$/);
  if (conversationStream) {
    const conversation = getConversation(conversationStream[1]);
    if (!conversation) return error("Conversation not found", 404);
    // I-1(专题2)快照协商:客户端带上缓存快照的令牌,与当前令牌一致 → 首帧只发轻量
    // snapshot_meta(客户端继续用缓存),大会话"切走再切回"不再整体重传。令牌不一致或
    // 未携带 → 照常全量快照。令牌语义见 api/snapshot-negotiation.ts。
    const clientToken = new URL(request.url).searchParams.get("token");
    const currentToken = conversationNegotiationToken(conversation);
    const initialFrame: [string, JsonValue | object] =
      clientToken && clientToken === currentToken
        ? ["snapshot_meta", { type: "snapshot_meta", seq: Date.now(), conversationId: conversation.id, updateAt: conversation.updateAt, isGenerating: generating.has(conversation.id), negotiationToken: currentToken, serverTime: Date.now() } satisfies ConversationSnapshotMetaEventDto]
        : ["snapshot", { type: "snapshot", seq: Date.now(), conversation: toSnapshotConversationDto(conversation, generating.has(conversation.id)), serverTime: Date.now(), negotiationToken: currentToken } satisfies ConversationSnapshotEventDto];
    // engine-status 帧是瞬态语义(重连即重置),压缩跨页/重连存活靠这份连接期快照:
    // 压缩进行中(compressing 注册表,服务端权威)则补发状态条帧(含 startedAt,
    // "已处理 xx秒"计时跨重连连续),切页回来即恢复显示。
    const compressStartedAt = compressing.get(conversation.id);
    // 域4-1:审批等待同哲学——等待中(awaitingApproval 注册表)补发琥珀态帧,侧栏/
    // 标签双态点与"已等待 xx秒"跨切页/重连续存。压缩与审批互斥(压缩时无工具执行),
    // 但快照逻辑各自独立判定,不互斥假设。
    const pendingApproval = awaitingApproval.get(conversation.id);
    const statusFrames: [string, JsonValue | object][] = [];
    if (compressStartedAt) {
      statusFrames.push(["engine-status", { busy: true, phase: "compacting", startedAt: compressStartedAt } satisfies EngineStatusEventDto]);
    }
    if (pendingApproval) {
      statusFrames.push(["engine-status", {
        busy: true,
        phase: "awaiting_approval",
        startedAt: pendingApproval.startedAt,
        ...(pendingApproval.toolName ? { toolName: pendingApproval.toolName } : {}),
        ...(pendingApproval.summary ? { summary: pendingApproval.summary } : {}),
      } satisfies EngineStatusEventDto]);
    }
    const initialFrames: [string, JsonValue | object][] = [initialFrame, ...statusFrames];
    return openSse(
      () => initialFrames,
      (controller) => {
        const set = conversationClients.get(conversation.id) ?? new Set<ReadableStreamDefaultController<Uint8Array>>();
        set.add(controller);
        conversationClients.set(conversation.id, set);
        return () => set.delete(controller);
      },
    );
  }

  const conversationRoute = path.match(/^conversations\/([^/]+)(?:\/(.*))?$/);
  if (conversationRoute) {
    const conversationId = conversationRoute[1];
    const sub = conversationRoute[2] ?? "";

    if (!sub && request.method === "DELETE") {
      deleteConversationsById(new Set([conversationId]));
      return new Response(null, { status: 204 });
    }
    // messages POST 的 body 在 ensureConversation 之前读:工作区绑定是创建期属性,
    // 必须随建档请求生效(会话首条消息才建档,事后无绑定时机)。body 只读这一次,
    // 下方 messages 分支复用。绑定前校验工作区存在,防悬空引用。
    let messagesBody: { parts?: JsonValue[]; workspaceId?: string } | null = null;
    if (sub === "messages" && request.method === "POST") {
      messagesBody = await readJson<{ parts?: JsonValue[]; workspaceId?: string }>(request);
      if (messagesBody.workspaceId && !getWorkspace(String(messagesBody.workspaceId))) {
        return error("Workspace not found", 404);
      }
    }
    const conversation = (sub === "messages" || sub === "system-prompt") && request.method === "POST"
      ? ensureConversation(conversationId, messagesBody?.workspaceId ? { workspaceId: String(messagesBody.workspaceId) } : undefined)
      : getConversation(conversationId);
    if (!conversation) return error("Conversation not found", 404);
    // DB-first:整个子路由块持有引用——translate/OCR 等长 await 期间实例不得被 sweep
    // 清出(否则另一请求 checkout 会装出第二实例,并发修改互相丢失)。try/finally 配对。
    checkoutConversation(conversation.id);
    try { // 块内 300+ 行保持原缩进(纯搬迁最小 diff),与结尾 } finally 配对

    // I-2:REST 详情保持全量(导出/分享/轮询兜底依赖完整数据),但同样附带 stamp 清单,
    // 客户端 detail 因此永远有清单可参与后续窗口化快照的前缀合并。
    if (!sub && request.method === "GET") return json(toSnapshotConversationDto(conversation, generating.has(conversation.id), Infinity));
    // I-2(专题2):窗口化快照的向上翻页分片。before/beforeId 双参防结构漂移:
    // beforeId 必须仍是 before 位置的节点(快照后发生删除/截断则 409,客户端重开流
    // 拿新快照与清单,自愈)。返回绝对下标 [max(0, before-limit), before) 的连续节点。
    if (sub === "nodes" && request.method === "GET") {
      const before = Number(url.searchParams.get("before") ?? "");
      const beforeId = url.searchParams.get("beforeId") ?? "";
      const rawLimit = Number(url.searchParams.get("limit") ?? "");
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : SNAPSHOT_NODE_WINDOW;
      if (!Number.isInteger(before) || before <= 0 || conversation.messages[before]?.id !== beforeId) {
        return error("Node window out of sync", 409);
      }
      const from = Math.max(0, before - limit);
      const slice = conversation.messages.slice(from, before);
      const page: ConversationNodesPageDto = {
        nodes: toMessageNodeDtos(slice),
        stamps: slice.map(nodeStamp),
        offset: from,
        updateAt: conversation.updateAt,
      };
      return json(page);
    }
    if (sub === "messages" && request.method === "POST") {
      // 压缩互斥(审计修复):compressConversation 完成时用"压缩开始时的消息快照"整体
      // 覆盖 conversation.messages——压缩窗口(LLM 摘要可达数十秒)内写入的新消息会被
      // 静默吞掉。send/regenerate/edit 三写入口一律 409,复用 compress_in_progress
      // 业务码(前端按码查 i18n,message 兜底)。auxiliary 落库防线是第二道保险。
      if (compressing.has(conversation.id)) {
        return error("已有压缩正在进行，请稍候", 409, "compress_in_progress");
      }
      const body = messagesBody ?? {};
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      // 用户在 ask_user 等待中直接发新消息时，旧 generation 可能还在跑（不太常
      // 见，因为 ask_user 通常会中止流并等待）也可能已经停了。无论如何先 abort
      // 旧 controller，避免后续 race；然后把上一条 ASSISTANT 残留的 pending 工具
      // 标记为"用户取消"，让历史回放时模型看到的是 denied tool 结果而不是空 output
      // ——对齐安卓 commit 05c12488 finishInterruptedPendingTools 的修复目标。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      // 直发新消息 = 用户继续对话的明确意图:解除遗留的打断冻结(终局三态注释见
      // queue/enqueue 空闲分支),新流收尾后队列恢复自动续跑。
      releaseMessageQueueHold(conversation.id);
      const processedParts = applyInputRegexTransformParts((body.parts ?? []) as MessagePart[], assistant);
      const userMessage = message("USER", markOcrPendingParts(processedParts, picked.model));
      bumpAnalyticsMsgCount();
      const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
      conversation.messages.push(userNode);
      conversation.chatSuggestions = [];
      conversation.updateAt = Date.now();
      if (!conversation.title) conversation.title = "New Conversation";
      persistConversation(conversation);
      broadcastConversation(conversation);
      void (async () => {
        // R2-2:续体自持引用——路由级 checkout 在 202 返回时即 release,慢 OCR(可 >60s)
        // 期间实例可能被 sweep 清出:续体写的是孤儿对象,generateAnswer 的 checkout 从活库
        // 装出第二实例,流式写进孤儿、persist 的却是陈旧实例(屏上看得到回答,重启后消失)。
        // 自持覆盖续体全程(checkout 在 IIFE 首个 await 前同步执行,与路由级引用无缝衔接),
        // working-set 不变式"持有实例期间 checkout 必返回同一实例"恢复成立。
        checkoutConversation(conversation.id);
        try {
          userMessage.parts = await attachOcrToImageParts(userMessage.parts, picked.model);
          // 批6复审 G1:长 await 期间会话可能已被删除/被导入替换——persistConversation 是
          // 无条件 upsert,直接落库会把已删会话连整棵消息树复活,generateAnswer 还会给僵尸
          // 会话续写。身份比对(非仅存在性)同时防"导入同 id 会话"后陈旧实例反向覆盖。
          if (getConversation(conversation.id) !== conversation) return;
          conversation.updateAt = Date.now();
          persistConversation(conversation);
          broadcastNodeUpdate(conversation, userNode);
          // generateAnswer 入口同步自持引用,续体无需 await 到生成结束
          void generateAnswer(conversation);
        } finally {
          releaseConversation(conversation.id);
        }
      })();
      return json({ status: "accepted" }, { status: 202 });
    }
    if (sub === "pin" && request.method === "POST") {
      conversation.isPinned = !conversation.isPinned;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "title" && request.method === "POST") {
      const body = await readJson<{ title: string }>(request);
      conversation.title = body.title?.trim() || conversation.title;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "move" && request.method === "POST") {
      const body = await readJson<{ assistantId: string }>(request);
      conversation.assistantId = body.assistantId;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "system-prompt" && request.method === "POST") {
      const body = await readJson<{ systemPrompt?: string }>(request);
      conversation.systemPrompt = String(body.systemPrompt ?? "").trim() || null;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "injections" && request.method === "POST") {
      // 专题9:会话级注入/世界书绑定(仅当助手开启 allowConversationPromptInjection 时
      // 前端才会调用;后端不强校验开关——存下无害,生成侧只在开关开时消费)。
      const body = await readJson<{ modeInjectionIds?: unknown; lorebookIds?: unknown }>(request);
      const toIds = (value: unknown) => (Array.isArray(value) ? value.map((v) => String(v)) : undefined);
      const modeIds = toIds(body.modeInjectionIds);
      const lorebookIds = toIds(body.lorebookIds);
      if (modeIds) conversation.modeInjectionIds = modeIds;
      if (lorebookIds) conversation.lorebookIds = lorebookIds;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "stop" && request.method === "POST") {
      // Abort the in-flight upstream fetch. Some providers take a moment to actually close the
      // socket after `controller.abort()` returns, so we proactively flush any throttled state
      // and broadcast immediately — the UI shouldn't have to wait for the next streaming chunk.
      const controller = generating.get(conversation.id);
      controller?.abort();
      generating.delete(conversation.id);
      // 终局三态之 Interrupted(用户问题①,对齐 Codex):停止意图支配队列——正在排队的
      // 消息不接棒点火(否则「打断一条又开始下一条」违背停止的本意),冻结保留等用户
      // 显式 resume。generateAnswer 的中止分支会再 hold 一次(纵深防御),此处先置是为
      // 了覆盖「流已不在跑、队列还挂着」的边缘态(stop 幂等连点)。
      holdMessageQueue(conversation.id);
      broadcastConversation(conversation);
      // 与新消息入口对齐：用户主动停止时，也把残留的 pending tool 标记成"用户取消"，
      // 否则下次重生成/继续时会基于一条 output 为空的 pending tool 节点继续。
      // 对齐安卓 commit 05c12488 把 finishInterruptedPendingTools 同时用在新消息
      // 和 stopGenerating 两条路径上。
      finishInterruptedPendingToolsInConversation(conversation);
      const lastNode = conversation.messages[conversation.messages.length - 1];
      if (lastNode) {
        const msg = lastNode.messages[lastNode.selectIndex];
        if (msg) {
          // Strip the loading placeholder — otherwise the user sees the typing "..." linger
          // because the placeholder part rendering doesn't depend on isGenerating.
          msg.parts = msg.parts.filter((part) => !(
            part && typeof part === "object" && !Array.isArray(part) && part.type === "loading"
          ));
          if (!msg.finishedAt) msg.finishedAt = new Date().toISOString();
        }
        broadcastNodeUpdate(conversation, lastNode);
      }
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      return json({ status: "stopped" });
    }
    // ── 消息发送队列(生成中补发不打断,FIFO 排队)─────────────────────────
    // 跨引擎统一:队列只压「待触发的生成」,派发由编排层在 generateAnswer 收尾时驱动,
    // 聊天/pi 共用同一队列与同一派发点。入队的用户消息本体已随 send 落库,这里只操作队列。
    if (sub === "queue/enqueue" && request.method === "POST") {
      if (compressing.has(conversation.id)) {
        return error("已有压缩正在进行，请稍候", 409, "compress_in_progress");
      }
      const body = await readJson<{ parts?: JsonValue[] }>(request);
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      const processedParts = applyInputRegexTransformParts((body.parts ?? []) as MessagePart[], assistant);
      const idle = !generating.has(conversation.id);
      if (idle) {
        // 空闲:与 send 同构——用户消息本体落库进历史并直接点火,不经队列(队列只压「因占用而待发」的)。
        // 用户发新消息 = 明确要继续对话:解除此前 stop 遗留的打断冻结(heldByInterrupt)——
        // 新流收尾走 Completed 终局,队列恢复自动续跑(对齐 Codex 新输入开 turn 后队列续跑)。
        releaseMessageQueueHold(conversation.id);
        const userMessage = message("USER", markOcrPendingParts(processedParts, picked.model));
        bumpAnalyticsMsgCount();
        const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
        conversation.messages.push(userNode);
        conversation.chatSuggestions = [];
        conversation.updateAt = Date.now();
        if (!conversation.title) conversation.title = "New Conversation";
        persistConversation(conversation);
        broadcastConversation(conversation);
        void (async () => {
          checkoutConversation(conversation.id);
          try {
            userMessage.parts = await attachOcrToImageParts(userMessage.parts, picked.model);
            if (getConversation(conversation.id) !== conversation) return;
            conversation.updateAt = Date.now();
            persistConversation(conversation);
            broadcastNodeUpdate(conversation, userNode);
            void generateAnswer(conversation);
          } finally {
            releaseConversation(conversation.id);
          }
        })();
        return json({ status: "accepted", queued: false }, { status: 202 });
      }
      // 生成中:入队 FIFO(事实源:改/撤/序都作用于它),同时推一份进 steering 通道——
      // 引擎在下一个模型请求边界(当前工具批结束)注入,无需等整轮完成(用户问题②,
      // 对齐 Codex pending_input)。注入成功时编排层会把该项移出队列;轮边界不存在
      // (纯文本流)则残留作废,收尾派发兜底,零丢失。
      const item = enqueueMessage(conversation.id, processedParts);
      pushSteeringMessage(conversation.id, item.id, processedParts);
      broadcastConversation(conversation);
      return json({ status: "queued", queued: true, id: item.id }, { status: 202 });
    }
    if (sub === "queue/pause" && request.method === "POST") {
      pauseMessageQueue(conversation.id);
      broadcastConversation(conversation);
      return json({ status: "paused" });
    }
    if (sub === "queue/resume" && request.method === "POST") {
      resumeMessageQueue(conversation.id);
      broadcastConversation(conversation);
      // 恢复即尝试点火:若当前空闲,立即派发队首。
      if (!generating.has(conversation.id)) dispatchMessageQueue(conversation.id);
      return json({ status: "resumed" });
    }
    const queueItem = sub.match(/^queue\/([^/]+)$/);
    if (queueItem && request.method === "DELETE") {
      const removed = removeQueuedMessage(conversation.id, decodeURIComponent(queueItem[1]));
      if (!removed) return error("Queue item not found", 404);
      broadcastConversation(conversation);
      return json({ status: "deleted" });
    }
    if (queueItem && request.method === "POST") {
      const body = await readJson<{ parts?: JsonValue[] }>(request);
      const itemId = decodeURIComponent(queueItem[1]);
      const ok = editQueuedMessage(conversation.id, itemId, (body.parts ?? []) as MessagePart[]);
      if (!ok) return error("Queue item not found", 404);
      // 编辑使 steering 通道里的同 id 项失效(通道持的是旧内容快照)——移出通道,
      // 编辑后的消息回到「收尾派发」路径(失去即时性,换内容正确性;对齐事实源纪律)。
      removeSteeringMessage(conversation.id, itemId);
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "voice/send" && request.method === "POST") {
      // 语音模式:发送一条语音转写消息,并把本轮 assistant 文本回传(供 TTS 播报)。
      // 复用消息发送队列(台账「与语音模式共用 MessageQueue」):空闲=同 send 直发,占用=入队
      // 由收尾派发。回复通道与队列绑定——派发该排队项时登记来源,收尾交付文本;直接发则生成后读取。
      if (compressing.has(conversation.id)) {
        return error("已有压缩正在进行，请稍候", 409, "compress_in_progress");
      }
      const body = await readJson<{ parts?: JsonValue[] }>(request);
      const text = textFromParts((body.parts ?? []) as MessagePart[]).trim();
      if (!text) return error("Empty utterance", 400);
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      const processedParts = applyInputRegexTransformParts((body.parts ?? []) as MessagePart[], assistant);

      const idle = !generating.has(conversation.id);
      let reply: string | null;
      if (idle) {
        // 空闲直发(与 send 同构):用户消息落库 → 点火 → 等待生成收尾后读本条 assistant 文本。
        // 同 send/queue-enqueue 空闲分支:直发=继续对话,解除遗留打断冻结。
        releaseMessageQueueHold(conversation.id);
        const userMessage = message("USER", markOcrPendingParts(processedParts, picked.model));
        bumpAnalyticsMsgCount();
        const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
        conversation.messages.push(userNode);
        conversation.chatSuggestions = [];
        conversation.updateAt = Date.now();
        if (!conversation.title) conversation.title = "New Conversation";
        persistConversation(conversation);
        broadcastConversation(conversation);
        reply = await (async () => {
          checkoutConversation(conversation.id);
          try {
            userMessage.parts = await attachOcrToImageParts(userMessage.parts, picked.model);
            if (getConversation(conversation.id) !== conversation) return null;
            conversation.updateAt = Date.now();
            persistConversation(conversation);
            broadcastNodeUpdate(conversation, userNode);
            await generateAnswer(conversation);
            if (getConversation(conversation.id) !== conversation) return null;
            // 读刚才生成的 assistant 消息(最后一条);abort/失败/空回复由文本为空兜成 null。
            const lastNode = conversation.messages[conversation.messages.length - 1];
            const assistantMsg = lastNode?.messages?.[lastNode.selectIndex];
            const replyText = assistantMsg?.role === "ASSISTANT" ? textFromParts(assistantMsg.parts).trim() : "";
            return replyText.length > 0 ? replyText : null;
          } finally {
            releaseConversation(conversation.id);
          }
        })();
      } else {
        // 生成中:入队(waitingReply 标记),等收尾派发 → 生成 → 回复通道交付文本。
        // 刻意不推 steering 通道:语音模式要「这句话的专属回复」做 TTS 播报,轮边界
        // 注入会把话并进在途任务、回复通道收 null(无可播报的独立回复)。语音的排队
        // 语义 = 排队等下一轮,键盘的排队语义 = 及时注入——分道是产品语义不是遗漏。
        const item = enqueueMessage(conversation.id, processedParts, { waitingReply: true });
        broadcastConversation(conversation);
        reply = await waitForQueuedReply(conversation.id, item.id);
      }
      return json({ status: "ok", reply });
    }
    if (sub === "regenerate-title" && request.method === "POST") {
      try {
        // 手动「重新生成标题」是用户显式点的一次动作:配了快速模型就用它,没配则回退
        // 会话模型(而非像自动生成那样静默跳过——用户点了按钮就期待有个 AI 标题)。
        const title = await generateTitleForConversation(
          conversation,
          resolveFastModelId() ?? conversationModelIdFor(conversation),
        );
        // R7-4:客户端已取消/超时断开则结果作废,不改写标题(取消语义硬保证)。
        if (request.signal.aborted) return error("Client cancelled", 499);
        // 批6复审 G1:标题生成期间会话可能已被删除——下方 persistConversation 是无条件
        // upsert,会复活它。已删/被替换即作废。
        if (getConversation(conversation.id) !== conversation) return error("Conversation not found", 404);
        conversation.title = title;
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err), 400);
      }
      persistConversation(conversation);
      broadcastConversation(conversation);
      return json({ status: "updated", title: conversation.title });
    }
    if (sub === "regenerate" && request.method === "POST") {
      // 压缩互斥:理由见 send 入口(压缩落库覆盖期间写入)。
      if (compressing.has(conversation.id)) {
        return error("已有压缩正在进行，请稍候", 409, "compress_in_progress");
      }
      const body = await readJson<{ messageId?: string }>(request);
      // 2-1:对齐 send 入口——先中止进行中的旧流。否则 generateAnswer 的 generating.set
      // 直接顶掉旧 controller,旧流成为无主流:与新流同写一个节点,或对已摘除节点持续
      // touchStream 广播幽灵帧。UI 虽屏蔽流式中的按钮,但 API 层必须自带守卫。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      let regenerateAtNodeId: string | undefined;
      if (body.messageId) {
        const nodeIndex = conversation.messages.findIndex((n) =>
          n.messages.some((m) => m.id === body.messageId),
        );
        if (nodeIndex >= 0) {
          const targetNode = conversation.messages[nodeIndex];
          const targetMsg = targetNode.messages.find((m) => m.id === body.messageId);
          if (targetMsg?.role === "ASSISTANT") {
            // 对齐安卓 regenerateAtMessage:重新生成 ASSISTANT = 在原 node 追加新分支,
            // 旧回复保留(前端 < 2 / 2 > 切换器生效)。截断到该 node(含)丢弃其后所有 node,
            // 保证组装 API 历史时上下文 = [0..nodeIndex-1]——新空分支会被
            // appendAssistantApiMessages.flushAssistant 跳过,旧分支不在 selectIndex 不被取到,
            // 等价于安卓的 messageRange = 0..<nodeIndex;同时避免"新回复 + 旧后续脱节"。
            conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
            const assistant = findAssistant(conversation.assistantId);
            const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
            const newMsg = message("ASSISTANT", [], picked.model.id);
            targetNode.messages.push(newMsg);
            targetNode.selectIndex = targetNode.messages.length - 1;
            regenerateAtNodeId = targetNode.id;
          } else {
            // USER 重新生成:截断到该 USER node(含),丢弃后续 assistant(行为不变)。
            truncateConversationForRegenerate(conversation, body.messageId);
          }
        } else {
          truncateConversationForRegenerate(conversation, body.messageId);
        }
      } else {
        truncateConversationForRegenerate(conversation, body.messageId);
      }
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      void generateAnswer(conversation, regenerateAtNodeId);
      return json({ status: "accepted" }, { status: 202 });
    }
    const nodeSelect = sub.match(/^nodes\/([^/]+)\/select$/);
    if (nodeSelect && request.method === "POST") {
      const body = await readJson<{ selectIndex?: number }>(request);
      const node = conversation.messages.find((item) => item.id === decodeURIComponent(nodeSelect[1]));
      if (!node) return error("Node not found", 404);
      const nextIndex = Number(body.selectIndex ?? node.selectIndex);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= node.messages.length) return error("Invalid branch index", 400);
      node.selectIndex = nextIndex;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      // I-2:老节点内容变化必须走按 id 寻址的 node_update——窗口化快照的清单比对
      // 只能发现"变了",节点本体靠这帧送达已加载它的客户端。
      broadcastNodeUpdate(conversation, node);
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    const messageDelete = sub.match(/^messages\/([^/]+)$/);
    if (messageDelete && request.method === "DELETE") {
      const messageId = decodeURIComponent(messageDelete[1]);
      let changed = false;
      let survivingChangedNode: MessageNode | null = null;
      conversation.messages = conversation.messages
        .map((node) => {
          const messages = node.messages.filter((msg) => msg.id !== messageId);
          if (messages.length !== node.messages.length) changed = true;
          const next = { ...node, messages, selectIndex: Math.min(node.selectIndex, Math.max(messages.length - 1, 0)) };
          if (messages.length !== node.messages.length && messages.length > 0) survivingChangedNode = next;
          return next;
        })
        .filter((node) => node.messages.length > 0);
      if (!changed) return error("Message not found", 404);
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      // I-2:删的是节点内某个分支(节点留存)时,同样按 id 推 node_update(理由同分支切换)。
      // 整节点消失是结构变化,由快照清单比对捕获,无需单帧。
      if (survivingChangedNode) broadcastNodeUpdate(conversation, survivingChangedNode);
      broadcastConversation(conversation);
      return json({ status: "deleted" });
    }
    const messageEdit = sub.match(/^messages\/([^/]+)\/edit$/);
    if (messageEdit && request.method === "POST") {
      // 压缩互斥:理由见 send 入口(压缩落库覆盖期间写入)。
      if (compressing.has(conversation.id)) {
        return error("已有压缩正在进行，请稍候", 409, "compress_in_progress");
      }
      const body = await readJson<{ parts?: JsonValue[] }>(request);
      // 2-1:对齐 send 入口——先中止进行中的旧流。否则 generateAnswer 的 generating.set
      // 直接顶掉旧 controller,旧流成为无主流:与新流同写一个节点,或对已摘除节点持续
      // touchStream 广播幽灵帧。UI 虽屏蔽流式中的按钮,但 API 层必须自带守卫。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      const messageId = decodeURIComponent(messageEdit[1]);
      const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
      if (nodeIndex < 0) return error("Message not found", 404);
      const node = conversation.messages[nodeIndex];
      const msg = node.messages.find((item) => item.id === messageId)!;
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      // 边界断言：body.parts 来自前端，契约即 UIMessagePart[]
      const editedParts = msg.role === "USER"
        ? applyInputRegexTransformParts((body.parts ?? msg.parts) as MessagePart[], assistant)
        : (body.parts ?? msg.parts) as MessagePart[];
      // 对齐安卓 ChatService.editMessage:编辑不覆盖原文,而是在同一节点追加新分支并
      // 选中——旧版本保留,气泡下出现 <1/2> 切换器。USER 编辑沿用 PC 一步式语义
      // (等价安卓的 编辑+重新发送 两步):截断后续并重新生成;ASSISTANT 编辑对齐安卓,
      // 只加分支,不截断后续、不重新生成。
      const edited = message(msg.role, markOcrPendingParts(editedParts, picked.model), msg.modelId);
      node.messages.push(edited);
      node.selectIndex = node.messages.length - 1;
      if (msg.role === "USER") {
        conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
        conversation.chatSuggestions = [];
      }
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      // I-2:被编辑节点按 id 推 node_update(理由同分支切换);其后的截断由快照清单捕获。
      broadcastNodeUpdate(conversation, node);
      broadcastConversation(conversation);
      if (msg.role === "USER") {
        void (async () => {
          // R2-2:同 messages POST 续体——自持引用覆盖 OCR 全程,防实例被 sweep 后分叉。
          checkoutConversation(conversation.id);
          try {
            edited.parts = await attachOcrToImageParts(edited.parts, picked.model);
            // 批6复审 G1:同 messages POST 续体——会话已删/被替换时丢弃结果,防复活。
            if (getConversation(conversation.id) !== conversation) return;
            conversation.updateAt = Date.now();
            persistConversation(conversation);
            broadcastNodeUpdate(conversation, node);
            void generateAnswer(conversation);
          } finally {
            releaseConversation(conversation.id);
          }
        })();
      }
      return json({ status: "updated" }, { status: msg.role === "USER" ? 202 : 200 });
    }
    const messageTranslate = sub.match(/^messages\/([^/]+)\/translate$/);
    if (messageTranslate && request.method === "POST") {
      const body = await readJson<{ targetLanguage?: string }>(request).catch(() => ({ targetLanguage: "" }));
      const messageId = decodeURIComponent(messageTranslate[1]);
      const node = conversation.messages.find((n) => n.messages.some((item) => item.id === messageId));
      const msg = node?.messages.find((item) => item.id === messageId);
      if (!node || !msg) return error("Message not found", 404);
      const sourceText = textFromParts(msg.parts).trim();
      if (!sourceText) return error("Message has no text to translate", 400);
      const targetLanguage = String(body.targetLanguage ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().locale;
      msg.translation = "正在翻译...";
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      void (async () => {
        // R2-2:续体自持引用(流式翻译可长于 60s sweep 闲置期),理由同 messages POST 续体。
        checkoutConversation(conversation.id);
        try {
          // 翻译模型未配置(AUTO 哨兵)或已删除 → 回退会话模型。同标题/建议的口径:
          // 绝不把哨兵交给 findModel(它兜底猜 gpt-4o-mini,服务商不提供就必 400)。
          const translationModelId = modelExists(state.settings.translateModeId)
            ? state.settings.translateModeId
            : conversationModelIdFor(conversation);
          const pickedTranslationModel = findModel(translationModelId);
          const useQwenMt = isQwenMtModel(pickedTranslationModel.model.modelId);
          const prompt = useQwenMt
            ? sourceText
            : applyPlaceholders(state.settings.translatePrompt || DEFAULT_TRANSLATION_PROMPT, {
                source_text: sourceText,
                target_lang: targetLanguage,
              });
          let streamedTranslation = "";
          let lastNodeBroadcastAt = 0;
          msg.translation = await fetchAuxiliaryText(translationModelId, prompt, "translation", {
            reasoningLevel: useQwenMt ? null : (state.settings.translateThinkingBudget ?? 0) > 0 ? "LOW" : null,
            temperature: useQwenMt ? 0.3 : null,
            topP: useQwenMt ? 0.95 : null,
            conversationId: conversation.id,
            customBody: useQwenMt
              ? { translation_options: { source_lang: "auto", target_lang: englishLanguageName(targetLanguage) } }
              : undefined,
            stream: !useQwenMt,
            // 2-3:onDelta 只改内存 + 33ms 节流的单节点广播。原先每个 token 都
            // persistConversation(全表删插)+saveState(全量序列化)+broadcastConversation
            // (全量快照帧),长会话流式翻译=每秒几十次全表重写,事件循环被持续占用。
            onDelta: (delta) => {
              streamedTranslation += delta;
              msg.translation = streamedTranslation || "正在翻译...";
              const now = Date.now();
              if (now - lastNodeBroadcastAt >= 33) {
                lastNodeBroadcastAt = now;
                broadcastNodeUpdate(conversation, node);
              }
            },
          });
        } catch (err) {
          msg.translation = `翻译失败：${err instanceof Error ? err.message : String(err)}`;
        } finally {
          // 2-3:落库收口到 finally 一次。同时修复原缺陷:非流式路径(Qwen-MT)与失败
          // 路径的 translation 从未 persistConversation,重启即丢。
          // 批6复审 G1:会话在翻译期间被删除/被导入替换时跳过落库,防无条件 upsert 复活。
          if (getConversation(conversation.id) === conversation) {
            conversation.updateAt = Date.now();
            persistConversation(conversation);
            // I-2:终帧按 id 推 node_update——33ms 节流可能吞掉最后一段流式增量,且
            // 窗口化客户端上翻译的老节点只能靠这帧拿到最终文本。
            broadcastNodeUpdate(conversation, node);
            broadcastConversation(conversation);
          }
          releaseConversation(conversation.id);
        }
      })();
      return json({ status: "accepted", translation: msg.translation }, { status: 202 });
    }
    if (sub === "compress" && request.method === "POST") {
      const body = await readJson<{ additionalPrompt?: string; targetTokens?: number; keepRecentMessages?: number }>(request);
      // 并发防线:前端 busy 互斥是组件态(切页即失忆),服务端必须自带守卫——两个压缩
      // 并发改写同一会话是数据竞争。
      if (compressing.has(conversation.id)) {
        return error("已有压缩正在进行，请稍候", 409, "compress_in_progress");
      }
      // 2-1:对齐 send 入口——先中止进行中的旧流。否则 generateAnswer 的 generating.set
      // 直接顶掉旧 controller,旧流成为无主流:与新流同写一个节点,或对已摘除节点持续
      // touchStream 广播幽灵帧。UI 虽屏蔽流式中的按钮,但 API 层必须自带守卫。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      // 压缩状态服务端权威(内测反馈:切页回来"过程条消失",误以为压缩被取消):
      // 开始/结束广播 engine-status(对话模式 UI 压缩从此与工作区引擎压缩同一状态条),
      // compressing 集合供 SSE 连接期补发快照(engine-status 帧瞬态,重连即重置)。
      const compressStartedAt = Date.now();
      compressing.set(conversation.id, compressStartedAt);
      broadcastEngineStatus(conversation.id, { busy: true, phase: "compacting", startedAt: compressStartedAt });
      broadcastList(); // 侧边栏绿灯即时点亮(列表 isGenerating 含压缩中)
      try {
        // P5:手动压缩优先走引擎原生 compaction——压引擎记忆(它才决定发给上游的
        // 上下文),UI 历史不动。targetTokens/keepRecentMessages 是 UI 历史压缩的参数,
        // 对引擎压缩无意义,只透传 additionalPrompt 作自定义指示。
        // 压缩路由收编:经注册表分发(与生成路由同源),每个引擎自带压缩机制;
        // 命中引擎无 compact 能力(chat)或工作区不可用(pi 不命中、落 chat 兜底)
        // 返回 null → 回落 UI 历史压缩,与生成路由降级一致。engine 报真实命中引擎。
        const engineResult = await compactEngineConversation(conversation, String(body.additionalPrompt ?? ""), request.signal);
        if (engineResult) {
          return json({ status: "compressed", engine: engineResult.engine, summaries: [engineResult.summary] });
        }
        // R7-4:透传 request.signal——客户端取消(压缩框取消键)后,compressConversation
        // 在分块间与落库前检查,保证取消后不改写会话。
        const summaries = await compressConversation(
          conversation,
          String(body.additionalPrompt ?? ""),
          Math.max(256, Number(body.targetTokens ?? 2000) || 2000),
          Math.max(0, Number(body.keepRecentMessages ?? 32) || 0),
          request.signal,
        );
        return json({ status: "compressed", summaries });
      } catch (err) {
        // 用户中止(请求 signal 断)是正常路径不是故障:静默吞掉,不写错误中心、不刷全局
        // toast——前端的取消 feedback 在发起侧(取消键/Esc 的 toast.info)。其余错误照常上浮。
        if (err instanceof DOMException && err.name === "AbortError") {
          return json({ status: "aborted" });
        }
        // CodedError 透传业务码,前端按码查 i18n 文案(message 兜底,通道见 foundation/errors)。
        const errorCode = err instanceof CodedError ? err.errorCode : undefined;
        return error(err instanceof Error ? err.message : String(err), 400, errorCode);
      } finally {
        compressing.delete(conversation.id);
        // 与工作区路径 orchestrator 的 finally busy:false 重复广播,幂等无害。
        broadcastEngineStatus(conversation.id, { busy: false });
        broadcastList(); // 绿灯熄灭
      }
    }
    if (sub === "fork" && request.method === "POST") {
      const body = await readJson<{ messageId?: string }>(request);
      const messageId = String(body.messageId ?? "");
      const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
      if (nodeIndex < 0) return error("Message not found", 404);
      // 节点必须换新 id:pc_message_node.id 是全局主键,沿用源节点 id 会让 upsert 的
      // ON CONFLICT 把源会话的节点行改挂到分支名下(源会话从 DB 重载后变空)。对齐 Android
      // forkConversationAtMessage 的 Uuid.random() 行为;消息 id 与 Android 一致保留。
      const forkedNodes = (JSON.parse(JSON.stringify(conversation.messages.slice(0, nodeIndex + 1))) as MessageNode[])
        .map((node) => ({ ...node, id: id() }));
      const forkId = id();
      const fork: Conversation = {
        ...JSON.parse(JSON.stringify(conversation)),
        id: forkId,
        title: conversation.title ? `${conversation.title} Fork` : "Fork",
        messages: forkedNodes,
        isPinned: false,
        createAt: Date.now(),
        updateAt: Date.now(),
        // P7:压缩记录随上方深拷贝整体复制;切点消息不在 fork 前缀内的记录,编码器按
        // "切点在场"自校验自动跳过,fork 无需感知压缩语义(P5 的 jsonl 副本复制随层退役)。
      };
      registerConversation(fork); // fork 树复制自内存源会话,内存即权威
      persistConversation(fork);
      broadcastList();
      return json({ conversationId: fork.id });
    }
    if (sub === "tool-approval" && request.method === "POST") {
      const body = await readJson<{ toolCallId?: string; approved?: boolean; reason?: string; answer?: string }>(request);
      let changed = false;
      for (const node of conversation.messages) {
        for (const msg of node.messages) {
          msg.parts = msg.parts.map((part) => {
            if (!part || typeof part !== "object" || Array.isArray(part) || part.type !== "tool" || part.toolCallId !== body.toolCallId) return part;
            changed = true;
            return {
              ...part,
              approvalState: body.approved
                ? { type: body.answer ? "answered" : "approved", answer: body.answer ?? "" }
                : { type: "denied", reason: body.reason ?? "" },
            };
          });
        }
      }
      if (!changed) return error("Tool call not found", 404);
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      broadcastConversation(conversation);
      // P3(方案 §4.4):审批内化后优先送达在途等待者(approval-gate 汇合),生成保持
      // 在跑,execute 原地放行/拒绝——不走"暂停→重触发续跑"。
      // 审批旁路判定收编(原 B-2 登记点):无等待者时"是否重触发"改问注册表的
      // resumeSemantics,不再以"工作区可用"旁路推断引擎——与生成路由同源,第三引擎
      // 接入时本端点自动跟随其声明的语义。run-and-suspend 引擎(pi)即使无等待者
      // (生成已死的孤儿审批:重启/停止后才点卡)也只记录状态:该类引擎无续跑模型,
      // 重触发会向引擎记忆重复注入末条用户消息;引擎侧悬空 toolCall 由 pi 在下轮
      // 请求时自愈(pi/packages/ai transform-messages 注入合成空结果)。
      const consumed = resolveToolApproval(conversation.id, String(body.toolCallId ?? ""), {
        approved: body.approved === true,
        ...(body.reason ? { reason: String(body.reason) } : {}),
        // ask_user:把答复载荷一并送达在途等待者(pi 引擎 execute 据此把答案回灌模型)。
        ...(body.answer != null ? { answer: String(body.answer) } : {}),
      });
      if (consumed || resolveEngineForConversation(conversation).resumeSemantics === "run-and-suspend") {
        return json({ status: "accepted" }, { status: 202 });
      }
      const hasPendingTools = conversation.messages.some((node) =>
        node.messages.some((msg) => hasPendingToolApproval(msg))
      );
      if (!hasPendingTools) {
        void generateAnswer(conversation);
        return json({ status: "accepted" }, { status: 202 });
      }
      return json({ status: "updated" });
    }
    } finally {
      releaseConversation(conversation.id);
    }
  }
  return null;
}
