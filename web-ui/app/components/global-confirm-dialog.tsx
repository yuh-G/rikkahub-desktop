// 7-4:confirmDialog() 的渲染端,root.tsx 挂载一次。见 stores/confirm-store.ts。
import { useTranslation } from "react-i18next";

import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { useConfirmStore } from "../stores/confirm-store";

export function GlobalConfirmDialog() {
  const { t } = useTranslation("common");
  const pending = useConfirmStore((s) => s.pending);
  const settle = useConfirmStore((s) => s.settle);

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{pending?.title}</DialogTitle>
          {pending?.description ? <DialogDescription>{pending.description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            {pending?.cancelLabel ?? t("confirm_dialog.cancel")}
          </Button>
          <Button variant={pending?.danger ? "destructive" : "default"} autoFocus onClick={() => settle(true)}>
            {pending?.confirmLabel ?? t("confirm_dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
