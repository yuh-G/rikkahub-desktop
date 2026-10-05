// stores/editing-store.ts — 消息编辑绑定的会话级全局状态
//
// 旧实现在窗格本地 useState 且切换会话即清(conversations.tsx 的 activeId effect),
// 而编辑文本/附件留在 drafts store 里按会话保留——切走再切回,输入框还带着编辑中的
// 内容但编辑绑定已丢,按发送会静默腐化成"发新消息"(原消息的附件还被当作新附件带上,
// shouldDeleteFileOnRemove 的差异清理也随之失效)。这是"切换会话保留状态"对齐
// (安卓 4a3eefc1)的 PC 缺口:安卓的 ChatInputState 挂在按会话键控的 ViewModel,
// 编辑绑定随 VM 存活,切回续编辑。
//
// 现在与 drafts 同款模式:按 conversationId 键控全局存活,窗格卸载/切换不丢;
// 编辑提交/取消/建议点击等终局路径显式清键。内存级,不持久化(重启回非编辑态是
// 合理预期——草稿文本仍在,只是不再是"编辑某条消息"的语境)。
import { create } from "zustand";

/** 编辑绑定的载荷。与窗格内 EditingSession 同形状(sourceParts 保留原消息 parts,
 *  提交时 buildEditedParts 以它为底做原位替换;textPartIndex 定位被替换的文本段)。 */
export interface EditingSession {
  messageId: string;
  sourceParts: import("~/types").UIMessagePart[];
  textPartIndex: number | null;
}

interface EditingStoreState {
  byConversation: Record<string, EditingSession>;
  beginEdit: (conversationId: string, session: EditingSession) => void;
  endEdit: (conversationId: string) => void;
  /** 会话删除/批量删除时清键,防孤儿绑定指向不存在的会话。 */
  endEditMany: (conversationIds: readonly string[]) => void;
}

export const useEditingStore = create<EditingStoreState>((set) => ({
  byConversation: {},
  beginEdit: (conversationId, session) =>
    set((state) => ({
      byConversation: { ...state.byConversation, [conversationId]: session },
    })),
  endEdit: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.byConversation)) return state;
      const next = { ...state.byConversation };
      delete next[conversationId];
      return { byConversation: next };
    }),
  endEditMany: (conversationIds) =>
    set((state) => {
      const present = conversationIds.filter((id) => id in state.byConversation);
      if (present.length === 0) return state;
      const next = { ...state.byConversation };
      for (const id of present) delete next[id];
      return { byConversation: next };
    }),
}));

/** 窄选择器:仅当前会话编辑态跳变才重渲染窗格。 */
export function useConversationEditingSession(
  conversationId: string | null,
): EditingSession | null {
  return useEditingStore(
    (state) => (conversationId ? (state.byConversation[conversationId] ?? null) : null),
  );
}
