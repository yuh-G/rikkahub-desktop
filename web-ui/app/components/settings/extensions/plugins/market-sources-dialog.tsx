// 「市场源」弹窗(方案 P6.2):风险提示 + 地址(必填)/ 名称(选填)/ 引擎(引擎数 ≥ 2 时);下半部分是已添加的
// 市场源与「移除」(内置的不列)。添加时后端按地址形态认类型并探测一次,成功后关闭弹窗、切到新页签。
import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { SettingsField } from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { SegmentedControl } from "~/components/ui/segmented-tabs";
import { extractErrorMessage } from "~/lib/error";
import { pluginsApi, refreshMarketSources } from "~/lib/plugins-api";
import { usePluginsViewStore } from "~/stores/plugins-view-store";
import type { PluginMarketSourceDto } from "~/types/plugins";

export function MarketSourcesDialog({
  open,
  onOpenChange,
  sources,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: readonly PluginMarketSourceDto[];
  onAdded: (source: PluginMarketSourceDto) => void;
}) {
  const { t } = useTranslation();
  const engines = usePluginsViewStore((state) => state.list?.engines);
  const [url, setUrl] = React.useState("");
  const [name, setName] = React.useState("");
  const [engine, setEngine] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const urlId = React.useId();
  const nameId = React.useId();
  const added = sources.filter((source) => !source.builtin);

  React.useEffect(() => {
    if (!open) return;
    setUrl("");
    setName("");
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!url.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const chosen = engines && engines.length >= 2 ? (engine ?? engines[0]!.id) : undefined;
      const { source } = await pluginsApi.addMarketSource({
        url: url.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(chosen ? { engine: chosen } : {}),
      });
      await refreshMarketSources().catch(() => undefined); // 表没刷到也不要紧:新页签在下次进市场时出现
      toast.success(t("settings:plugins.source_added", { name: source.name }));
      onAdded(source);
      onOpenChange(false);
    } catch (err) {
      setError(extractErrorMessage(err, t("settings:plugins.action_failed")));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (source: PluginMarketSourceDto) => {
    setRemoving(source.id);
    try {
      await pluginsApi.removeMarketSource(source.id);
      await refreshMarketSources();
      toast.success(t("settings:plugins.source_removed", { name: source.name }));
    } catch (err) {
      toast.error(extractErrorMessage(err, t("settings:plugins.action_failed")));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings:plugins.market_sources")}</DialogTitle>
          <DialogDescription className="sr-only">{t("settings:plugins.market_trust_notice")}</DialogDescription>
        </DialogHeader>
        <Notice tone="danger">{t("settings:plugins.market_trust_notice")}</Notice>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SettingsField label={t("settings:plugins.source_url")} htmlFor={urlId} hint={t("settings:plugins.source_url_hint")}>
            <Input
              id={urlId}
              autoFocus
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t("settings:plugins.source_url_placeholder")}
              disabled={saving}
            />
          </SettingsField>
          <SettingsField label={t("settings:plugins.source_name")} htmlFor={nameId}>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("settings:plugins.source_name_placeholder")}
              disabled={saving}
            />
          </SettingsField>
          {engines && engines.length >= 2 ? (
            <SettingsField label={t("settings:plugins.source_engine")}>
              <SegmentedControl
                items={engines.map((item) => ({ value: item.id, label: item.label }))}
                value={engine ?? engines[0]!.id}
                onChange={setEngine}
                aria-label={t("settings:plugins.source_engine")}
              />
            </SettingsField>
          ) : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              {t("settings:plugins.cancel")}
            </Button>
            <Button type="submit" disabled={!url.trim() || saving}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {t(saving ? "settings:plugins.syncing" : "settings:plugins.add_source")}
            </Button>
          </DialogFooter>
        </form>
        {added.length > 0 ? (
          <section className="space-y-1.5 border-t border-[var(--ds-divider)] pt-4">
            <h3 className="text-xs font-semibold text-[var(--ds-text-secondary)]">{t("settings:plugins.added_sources")}</h3>
            <ul className="divide-y divide-[var(--ds-divider)]">
              {added.map((source) => (
                <li key={source.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[var(--ds-text-primary)]">{source.name}</div>
                    <div className="truncate text-xs text-[var(--ds-text-tertiary)]" title={source.url}>
                      {source.url}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="compact"
                    disabled={removing !== null}
                    onClick={() => void remove(source)}
                  >
                    {removing === source.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    {t("settings:plugins.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
