import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

interface RenameConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTitle: string;
  onConfirm: (newTitle: string) => void;
}

// 替代 window.prompt 的会话重命名弹窗。WebView2 的原生 prompt 标题栏硬编码
// "localhost:8080 显示",无法定制、且样式与应用割裂;改用应用内 Dialog + Input,
// 与"搜索对话"等弹窗观感一致。打开时预填当前标题并全选,方便整体覆盖输入;
// Enter 直接提交,Esc 取消(Dialog 自带)。
export function RenameConversationDialog({
  open,
  onOpenChange,
  currentTitle,
  onConfirm,
}: RenameConversationDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = React.useState(currentTitle);

  // 打开时把输入框重置为当前标题(同一 Dialog 实例服务多个会话,每次打开都要刷新初值)
  React.useEffect(() => {
    if (open) setValue(currentTitle);
  }, [open, currentTitle]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== currentTitle.trim();

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("conversation_sidebar.edit_title")}</DialogTitle>
        </DialogHeader>
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t("conversation_sidebar.edit_title_prompt")}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("conversation_sidebar.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {t("conversation_sidebar.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
