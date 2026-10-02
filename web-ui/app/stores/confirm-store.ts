// 7-4:Promise 化全局确认框。替代 window.confirm——WebView2 原生框标题栏硬编码
// "localhost:8080 显示",无法定制且样式割裂(项目在重命名 Dialog 处已认定不可接受)。
// 用法:`if (!(await confirmDialog({ title: "确定删除吗?" }))) return;`
// UI 由 root.tsx 挂载的 <GlobalConfirmDialog/> 渲染,同一时刻只存在一个请求,
// 新请求到来时旧请求按"取消"落定(与原生 confirm 的模态语义一致,实际不会并发)。
import { create } from "zustand";

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** 确认按钮文案;缺省用 common:confirm_dialog.confirm */
  confirmLabel?: string;
  /** 取消按钮文案;缺省用 common:confirm_dialog.cancel。两个选项都是正当选择时(而非"做/不做")用它说清取消的含义 */
  cancelLabel?: string;
  /** 危险操作(删除/恢复覆盖)确认钮走 destructive 样式 */
  danger?: boolean;
}

interface ConfirmStoreState {
  pending: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  open: (req: ConfirmOptions & { resolve: (ok: boolean) => void }) => void;
  settle: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmStoreState>((set, get) => ({
  pending: null,
  open: (req) => {
    get().pending?.resolve(false);
    set({ pending: req });
  },
  settle: (ok) => {
    const current = get().pending;
    if (!current) return;
    set({ pending: null });
    current.resolve(ok);
  },
}));

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.getState().open({ ...options, resolve }));
}
