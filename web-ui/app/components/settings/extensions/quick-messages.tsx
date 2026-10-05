// components/settings/extensions/quick-messages.tsx — 拓展 › 快捷消息模板

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { copyItemName } from "~/lib/copy-name";
import { createId } from "~/lib/id";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { AssistantProfile, Settings } from "~/types";
import {
  clone,
  copyRowAction,
  deleteRowAction,
  moveItem,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsField,
  SettingsGroup,
  SettingsStack,
  textValue,
} from "~/components/settings/shared";
import {
  BindingAssistantSelect,
  BindingSwitch,
  EditorShell,
  NoAssistantsState,
  pullSettings,
  type SectionProps,
  useBindingAssistant,
} from "~/components/settings/extensions/common";

/** 拓展 › 快捷消息模板。 */
export function QuickMessagesSection({ settings, onSettings }: SectionProps) {
  const assistant = useBindingAssistant(settings);
  if (!assistant) return <NoAssistantsState />;
  return (
    <QuickMessageEditor
      settings={settings}
      assistant={assistant}
      onSettings={onSettings}
      bindingSelect={<BindingAssistantSelect settings={settings} assistant={assistant} stretch className="mb-1" />}
    />
  );
}

function QuickMessageEditor({
  settings,
  assistant,
  onSettings,
  bindingSelect,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
  bindingSelect: React.ReactNode;
}) {
  const { t } = useTranslation();
  const items = (settings.quickMessages ?? []) as unknown as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected = items.find((item) => String(item.id) === selectedId) ??
    items[0] ?? { id: createId(), title: "", content: "" };
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      await api.post("settings/quick-message/detail", draft);
      await pullSettings(onSettings);
    },
    { errorLabel: t("settings:mcp.tab.quick") },
  );
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
      autosave.reset();
    }
  }, [selectedId]);
  const patchDraft = (patch: Record<string, unknown>) => {
    autosave.markDirty();
    setDraft({ ...draft, ...patch });
  };
  // 复制快捷消息:克隆配置(新 id、「原名 (N)」),落盘后选中新副本。
  const copyById = async (targetId: string) => {
    const target = items.find((item) => String(item.id) === targetId);
    if (!target) return;
    const next = {
      ...clone(target),
      id: createId(),
      title: copyItemName(textValue(target.title) || t("settings:mcp.tab.quick"), new Set(items.map((item) => textValue(item.title)))),
    } as Record<string, unknown>;
    try {
      await api.post("settings/quick-message/detail", next);
      await pullSettings(onSettings);
      setSelectedId(String(next.id));
      setDraft(clone(next));
      autosave.reset();
      toast.success(t("settings:mcp.copied", { name: textValue(next.title) || t("settings:mcp.tab.quick") }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.copy_failed"));
    }
  };
  // 删除收口到列表行(右键/悬停「⋯」):按目标行 id 删,不再依赖右侧草稿。
  const removeById = async (targetId: string) => {
    const target = items.find((item) => String(item.id) === targetId);
    if (!target) return;
    if (!(await confirmDialog({ title: t("settings:mcp.quick.delete_confirm", { name: textValue(target.title) }), danger: true }))) return;
    // 防复活:仅当删的是正在编辑的那条才 discard;删除后显式选中下一条(复审 F1/F2)
    const removingActive = String(draft.id) === targetId;
    if (removingActive) await autosave.discard();
    const remaining = items.filter((item) => String(item.id) !== targetId);
    await api.delete(`settings/quick-message/${targetId}`);
    await pullSettings(onSettings);
    if (removingActive) {
      if (remaining.length) setSelectedId(String(remaining[0].id));
      else setDraft({ id: createId(), title: "", content: "" });
    }
  };
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.quickMessageIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      quickMessageIds: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.quick.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.title) || t("settings:mcp.tab.quick")}
      listHeader={bindingSelect}
      rowMenuOf={(item) => {
        const id = String(item.id ?? "");
        if (!id) return undefined;
        return [
          copyRowAction(() => copyById(id)),
          deleteRowAction(() => removeById(id)),
        ];
      }}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, quickMessages: next as unknown as Settings["quickMessages"] });
        await api.post("settings/quick-message/reorder", {
          ids: next.map((item) => String(item.id)),
        });
      }}
      onCreate={async () => {
        // 新建即保存(与另外四个编辑器同款):只置脏等防抖的话,选中校正 effect 在 settings
        // 里找不到新 id,会把选中跳回第一条,新建的模板随之丢失。
        const next = { id: createId(), title: t("settings:mcp.tab.quick"), content: "" };
        try {
          await api.post("settings/quick-message/detail", next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(next);
          autosave.reset();
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : t("settings:mcp.item_create_failed", { title: t("settings:mcp.tab.quick") }),
          );
        }
      }}
    >
      <div className="@container">
        <SettingsStack>
          <SettingsDetailHeader
            title={textValue(draft.title)}
            titlePlaceholder={t("settings:mcp.tab.quick")}
            titleLabel={t("settings:mcp.quick.title")}
            onTitleCommit={(title) => patchDraft({ title })}
            description={t("settings:mcp.quick.page_desc")}
            action={
              <BindingSwitch
                checked={(assistant.quickMessageIds ?? []).includes(String(draft.id))}
                onCheckedChange={(checked) => void bind(checked)}
              />
            }
          />
          <SettingsGroup fields>
            <SettingsField label={t("settings:mcp.quick.content")} hint={t("settings:mcp.quick.content_hint")}>
              <Textarea
                value={textValue(draft.content)}
                onChange={(event) => patchDraft({ content: event.target.value })}
                className="min-h-52"
              />
            </SettingsField>
          </SettingsGroup>
          <SettingsDetailFooter
            status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
          />
        </SettingsStack>
      </div>
    </EditorShell>
  );
}
