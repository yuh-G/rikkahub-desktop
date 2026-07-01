// 全窗口文件拖拽投放区:在对话页,把整个应用窗口都变成文件投放目标。
//
// 工作方式:在 window 上监听 dragenter/dragover/dragleave/drop。只要拖入的是文件、
// 且当前对话就绪、不在上传中,就蒙一层半透明遮罩提示"松开以上传";在窗口任意位置
// 松手都会上传、并把附件挂到当前对话草稿(复用输入框那条上传链路,共享 store 里的
// uploading 状态,两边互斥、转圈同步)。
//
// 只在对话页渲染(由 ConversationsPageInner 挂载),所以设置页 / 图片页天然不响应
// —— 那些页面拖文件没有合理语义,避免误操作。
//
// dragDepthRef 用于消除"拖入子元素时反复触发 dragenter/dragleave 导致遮罩闪烁":
// 每进入一个元素 +1、离开 -1,归零才认为真的离开了窗口。
import * as React from "react";
import { UploadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useChatInputStore } from "~/stores";
import { hasFilesInDataTransfer, uploadFilesToDraft } from "~/lib/upload";

interface GlobalDropZoneProps {
  // 当前对话草稿 key(null = 还没选定对话,此时不接收投放)
  draftKey: string | null;
  // 对话正在加载 / 出错时禁用(和输入框一致)
  disabled: boolean;
}

export function GlobalDropZone({ draftKey, disabled }: GlobalDropZoneProps) {
  const { t } = useTranslation("input");
  const uploading = useChatInputStore((state) => state.uploading);
  const addParts = useChatInputStore((state) => state.addParts);
  const [active, setActive] = React.useState(false);
  const dragDepthRef = React.useRef(0);

  React.useEffect(() => {
    // 是否处于"可接收投放"的状态。生成中仍允许(用户常在模型输出时准备下一轮附件)。
    const canAccept = () => draftKey !== null && !disabled && !uploading;

    const onDragEnter = (event: DragEvent) => {
      if (!canAccept() || !hasFilesInDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setActive(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!canAccept() || !hasFilesInDataTransfer(event.dataTransfer)) return;
      // 必须 preventDefault,否则 WebView2 / 浏览器会把文件当成"打开/导航"处理
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setActive(true);
    };

    const onDragLeave = (event: DragEvent) => {
      // 不检查 dataTransfer:Chromium 在 dragleave 时会清空 dataTransfer.items(隐私保护),
      // 此刻已读不到文件信息。dragenter 已经过滤掉非文件拖拽,这里只需和 enter 配对地
      // 递减计数即可——同一拖拽操作的 dataTransfer 类型不会中途变化,enter/leave 配对平衡。
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setActive(false);
      }
    };

    const onDrop = async (event: DragEvent) => {
      if (!hasFilesInDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setActive(false);
      const key = draftKey;
      if (!key || disabled || uploading) return;
      const result = await uploadFilesToDraft(event.dataTransfer?.files ?? null, (parts) =>
        addParts(key, parts),
      );
      if (result.error) toast.error(result.error);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [addParts, disabled, draftKey, uploading]);

  React.useEffect(() => {
    // 离开对话页 / 对话切换导致 draftKey 变 null 时,确保遮罩不会卡住
    if (draftKey === null || disabled) {
      setActive(false);
      dragDepthRef.current = 0;
    }
  }, [draftKey, disabled]);

  if (!active) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/50 bg-card/95 px-12 py-10 text-center shadow-2xl">
        <UploadCloud className="size-12 text-primary" />
        <p className="text-base font-medium text-primary">
          {t("chat.drop_anywhere_to_upload")}
        </p>
      </div>
    </div>
  );
}
