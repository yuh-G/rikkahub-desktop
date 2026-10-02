// 拓展三页(技能 / 提示词注入 / 快捷消息模板)共用的「作用于助手」选择。只在内存。
// null = 跟随当前对话助手(settings.assistantId);只有用户在下拉里手动选了才写入。每次打开设置
// 都复位为 null:用户从输入框的拓展选择器点「管理」进来时,要管理的正是当前助手。
import { create } from "zustand";

interface ExtensionBindingState {
  assistantId: string | null;
}

export const useExtensionBindingStore = create<ExtensionBindingState>(() => ({ assistantId: null }));

export function setBindingAssistant(assistantId: string): void {
  useExtensionBindingStore.setState({ assistantId });
}

export function resetBindingAssistant(): void {
  useExtensionBindingStore.setState({ assistantId: null });
}
