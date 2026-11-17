import type { Settings, UIMessagePart } from "~/types";
import type { ExtensionSelection } from "@server/assistants/extension-selection";

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
  /** 还没落库的新会话在左下角「MCP 与拓展」里改过的几项(D19),键同 drafts;随第一条消息带给建会话的
   *  请求,没改过的类别按助手的默认。与文字草稿分开存:编辑回填会整份替换文字草稿。 */
  extensionDrafts: Record<string, Partial<ExtensionSelection>>;
  patchExtensionDraft: (draftKey: string, patch: Partial<ExtensionSelection>) => void;
  clearExtensionDraft: (draftKey: string) => void;
  // 是否正在上传文件。放在全局 store 而非组件本地,是为了让输入框和全窗口投放区
  // 共享同一份 busy 状态:任一入口触发上传时,另一处的 UI(转圈、禁用按钮)同步响应,
  // 并在并发上传时互斥。
  uploading: boolean;
  setUploading: (uploading: boolean) => void;
  // 专题4:上传百分比(0-100);null = 不在上传。驱动输入框上传 chip 的确定性进度圆圈。
  uploadProgress: number | null;
  setUploadProgress: (progress: number | null) => void;
  // 域9-1(交互审查 3B):仍处"解析中"的草稿附件 fileId 集合。附件 chip 的 ExtractionBadge
  // 轮询结果写入这里(单一状态源=chip 同款轮询,门禁不另造轮询);发送门禁据此判
  // "是否有附件还在解析"→ 发送按钮灰 + 发送键短路。done/failed/empty/none 即移出。
  parsingFileIds: number[];
  setPartParsing: (fileId: number, parsing: boolean) => void;
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
