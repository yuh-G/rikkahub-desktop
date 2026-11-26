// hooks/use-extension-selection.ts — 输入框左下角「拓展」读写的那一份选择(D19,方案 §5.12)。
//
// 已有会话:会话此刻实际用的选择(没固定过的跟随会话所属助手的默认),改动写会话,只发改了的键。
// 还没落库的新会话:助手的默认叠上草稿仓库里改过的几项,改动只进草稿,随第一条消息带上。

import * as React from "react";
import { useShallow } from "zustand/react/shallow";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import api from "~/services/api";
import { useChatInputStore } from "~/stores";
import { useConversationStore } from "~/stores/conversation-store";
import {
  type ExtensionSelection,
  effectiveSelection,
  initialSelection,
} from "@server/assistants/extension-selection";

export function useExtensionSelection(conversationId: string | null | undefined, draftKey: string | null | undefined) {
  const { settings, currentAssistant } = useCurrentAssistant();
  // 窄订阅:流式期间 entry 每帧重建,这里只取选择相关的几项,内容不变时常驻输入区不重渲染。
  const source = useConversationStore(
    useShallow((state) => {
      const detail = conversationId ? state.entries[conversationId]?.detail : null;
      if (!detail) return null;
      return {
        assistantId: detail.assistantId,
        extensionSelection: detail.extensionSelection ?? null,
        modeInjectionIds: detail.modeInjectionIds,
        lorebookIds: detail.lorebookIds,
      };
    }),
  );
  const draftPatch = useChatInputStore((state) => (draftKey ? state.extensionDrafts[draftKey] : undefined));
  const patchExtensionDraft = useChatInputStore((state) => state.patchExtensionDraft);
  const assistant =
    (source && settings?.assistants.find((item) => item.id === source.assistantId)) || currentAssistant;

  // 写会话时的乐观叠加:连点两下时第二下要基于第一下的结果算。广播的快照与接口的响应谁先到不定,
  // 所以成功后不撤,等写入都落定后会话快照再变时撤;失败立即撤。
  const [pending, setPending] = React.useState<Partial<ExtensionSelection>>({});
  const inflight = React.useRef(0);
  React.useEffect(() => {
    if (inflight.current === 0) setPending({});
  }, [conversationId, source]);

  const selection = React.useMemo(() => {
    const base = conversationId ? effectiveSelection(source, assistant) : initialSelection(assistant, draftPatch);
    return { ...base, ...pending };
  }, [conversationId, source, assistant, draftPatch, pending]);

  const change = React.useCallback(
    async (patch: Partial<ExtensionSelection>) => {
      if (!conversationId) {
        if (draftKey) patchExtensionDraft(draftKey, patch);
        return;
      }
      setPending((prev) => ({ ...prev, ...patch }));
      inflight.current += 1;
      try {
        await api.post<{ status: string }>(`conversations/${conversationId}/extension-selection`, patch);
      } catch (error) {
        setPending({});
        throw error;
      } finally {
        inflight.current -= 1;
      }
    },
    [conversationId, draftKey, patchExtensionDraft],
  );

  const ready = Boolean(settings && assistant && (conversationId ? source : draftKey));
  return { settings, selection, change, ready };
}
