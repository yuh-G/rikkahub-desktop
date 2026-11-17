import type { StateCreator } from "zustand";

import type { AppStoreState, ChatInputSlice, Draft } from "~/stores/slices/types";
import type { UIMessagePart } from "~/types";

const EMPTY_DRAFT: Draft = {
  text: "",
  parts: [],
};

function getDraft(drafts: Record<string, Draft>, conversationId: string): Draft {
  return drafts[conversationId] ?? EMPTY_DRAFT;
}

export const createChatInputSlice: StateCreator<AppStoreState, [], [], ChatInputSlice> = (
  set,
  get,
) => ({
  drafts: {},
  extensionDrafts: {},
  patchExtensionDraft: (draftKey, patch) =>
    set((state) => ({
      extensionDrafts: { ...state.extensionDrafts, [draftKey]: { ...state.extensionDrafts[draftKey], ...patch } },
    })),
  clearExtensionDraft: (draftKey) =>
    set((state) => {
      if (!(draftKey in state.extensionDrafts)) return state;
      const next = { ...state.extensionDrafts };
      delete next[draftKey];
      return { extensionDrafts: next };
    }),
  uploading: false,
  setUploading: (uploading) => set({ uploading }),
  uploadProgress: null,
  setUploadProgress: (uploadProgress) => set({ uploadProgress }),
  parsingFileIds: [],
  setPartParsing: (fileId, parsing) =>
    set((state) => {
      const has = state.parsingFileIds.includes(fileId);
      if (parsing === has) return state; // 幂等:轮询每 600ms 来一次,避免无效重渲染
      return {
        parsingFileIds: parsing
          ? [...state.parsingFileIds, fileId]
          : state.parsingFileIds.filter((id) => id !== fileId),
      };
    }),
  setText: (conversationId, text) => {
    set((state) => {
      const draft = getDraft(state.drafts, conversationId);
      return {
        drafts: {
          ...state.drafts,
          [conversationId]: {
            ...draft,
            text,
          },
        },
      };
    });
  },
  addParts: (conversationId, parts) => {
    if (parts.length === 0) return;

    set((state) => {
      const draft = getDraft(state.drafts, conversationId);
      return {
        drafts: {
          ...state.drafts,
          [conversationId]: {
            ...draft,
            parts: [...draft.parts, ...parts],
          },
        },
      };
    });
  },
  removePartAt: (conversationId, index) => {
    set((state) => {
      const draft = state.drafts[conversationId];
      if (!draft) return state;
      if (index < 0 || index >= draft.parts.length) return state;

      return {
        drafts: {
          ...state.drafts,
          [conversationId]: {
            ...draft,
            parts: draft.parts.filter((_, partIndex) => partIndex !== index),
          },
        },
      };
    });
  },
  clearDraft: (conversationId) => {
    set((state) => {
      if (!(conversationId in state.drafts)) return state;
      const nextDrafts = { ...state.drafts };
      delete nextDrafts[conversationId];
      return { drafts: nextDrafts };
    });
  },
  isEmpty: (conversationId) => {
    const draft = get().drafts[conversationId];
    if (!draft) return true;
    return draft.text.trim().length === 0 && draft.parts.length === 0;
  },
  getSubmitParts: (conversationId) => {
    const draft = get().drafts[conversationId];
    if (!draft) return [];

    const hasText = draft.text.trim().length > 0;
    if (!hasText) {
      return draft.parts;
    }

    const textPart: UIMessagePart = {
      type: "text",
      text: draft.text,
    };

    return [textPart, ...draft.parts];
  },
});
