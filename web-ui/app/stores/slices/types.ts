import type { Settings, UIMessagePart } from "~/types";

export interface Draft {
  text: string;
  parts: UIMessagePart[];
}

export interface SettingsSlice {
  settings: Settings | null;
  setSettings: (settings: Settings) => void;
}

export interface ChatInputSlice {
  drafts: Record<string, Draft>;
  // 是否正在上传文件。放在全局 store 而非组件本地,是为了让输入框和全窗口投放区
  // 共享同一份 busy 状态:任一入口触发上传时,另一处的 UI(转圈、禁用按钮)同步响应,
  // 并在并发上传时互斥。
  uploading: boolean;
  setUploading: (uploading: boolean) => void;
  setText: (conversationId: string, text: string) => void;
  addParts: (conversationId: string, parts: UIMessagePart[]) => void;
  removePartAt: (conversationId: string, index: number) => void;
  clearDraft: (conversationId: string) => void;
  isEmpty: (conversationId: string) => boolean;
  getSubmitParts: (conversationId: string) => UIMessagePart[];
}

export interface ClockSlice {
  clockOffset: number;
  setClockOffset: (serverTime: number) => void;
}

export type AppStoreState = SettingsSlice & ChatInputSlice & ClockSlice;
