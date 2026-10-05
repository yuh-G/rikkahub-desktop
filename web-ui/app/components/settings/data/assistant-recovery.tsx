// components/settings/data/assistant-recovery.tsx — 数据恢复卡:找回引用已删助手的会话。
// 会话列表/搜索全部按当前助手过滤,删掉助手后其会话在所有视图里隐身(数据仍在库中)。
// 挂载即扫描:有缺失才渲染卡片(健康用户零噪);恢复=为缺失 id 建占位助手,会话即刻可见。
// 助手的其他配置(人设/模型)无法从会话记录重建,恢复后由用户接手编辑。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/notice";
import api from "~/services/api";

interface MissingAssistant {
  assistantId: string;
  conversationCount: number;
}

export function AssistantRecoveryCard() {
  const { t } = useTranslation();
  // null=扫描中(undefined 语义留给"还没发起");[] 扫完无缺失 → 不渲染。
  const [missing, setMissing] = React.useState<MissingAssistant[] | null>(null);
  const [recovering, setRecovering] = React.useState(false);

  const rescan = React.useCallback(() => {
    api
      .get<{ missing: MissingAssistant[] }>("data/assistant-recovery")
      .then((res) => setMissing(res.missing))
      .catch(() => setMissing([])); // 查询失败按无缺失处理:恢复入口是兜底,不常驻报错
  }, []);

  React.useEffect(() => {
    rescan();
  }, [rescan]);

  if (missing === null || missing.length === 0) return null;

  const recover = async () => {
    setRecovering(true);
    try {
      const res = await api.post<{ recovered: number; missing: MissingAssistant[] }>("data/assistant-recovery");
      setMissing(res.missing);
      toast.success(t("settings:data.assistant_recovery_done", { count: res.recovered }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:data.assistant_recovery_failed"));
    } finally {
      setRecovering(false);
    }
  };

  return (
    <Notice tone="warning">
      <div className="font-medium">{t("settings:data.assistant_recovery_title")}</div>
      <p className="mt-1 text-[var(--ds-text-secondary)]">
        {t("settings:data.assistant_recovery_desc", { count: missing.length })}
      </p>
      <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-[var(--ds-text-secondary)]">
        {missing.map((item) => (
          <li key={item.assistantId} className="break-all">
            {item.assistantId}
            <span className="ml-1.5 font-sans">
              {t("settings:data.assistant_recovery_conv_count", { count: item.conversationCount })}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button size="compact" disabled={recovering} onClick={() => void recover()}>
          {recovering ? <Loader2 className="animate-spin" /> : <History />}
          {t("settings:data.assistant_recovery_action")}
        </Button>
        <Button size="compact" variant="ghost" disabled={recovering} onClick={rescan}>
          {t("settings:data.assistant_recovery_rescan")}
        </Button>
      </div>
    </Notice>
  );
}
