import * as React from "react";
import { Check, ChevronDown, LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useFontCatalog, useInvalidateFontCatalog } from "~/hooks/use-font-catalog";
import { extractErrorMessage } from "~/lib/error";
import { composeFontChain, entryMatches } from "~/lib/font-chain";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { FontEntry } from "~/types/font";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useTranslation } from "react-i18next";
import { confirmDialog } from "~/stores/confirm-store";

// 通用 CSS 栈选项(无字体文件,前端固定)。id 保持稳定以兼容老用户已存的 uiFontFamily 值。
interface GenericFontOption {
  id: string;
  labelKey: string;
  /** 抽 i18n key 前的原中文 label。老版本可能把它存进 uiFontFamily,匹配时必须继续认。 */
  legacyLabel: string;
  family: string;
}
const GENERIC_FONTS: GenericFontOption[] = [
  { id: "__system", labelKey: "font_picker.follow_system", legacyLabel: "跟随系统", family: "" },
  {
    id: "tailwind-sans",
    labelKey: "font_picker.sans_stack",
    legacyLabel: "无衬线（系统栈）",
    family:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
  },
  {
    id: "tailwind-serif",
    labelKey: "font_picker.serif_stack",
    legacyLabel: "衬线（系统栈）",
    family: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    id: "tailwind-mono",
    labelKey: "font_picker.mono_stack",
    legacyLabel: "等宽（系统栈）",
    family:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
];

const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2,.ttc";

// 由当前选中的 value(可能是 id / cssName / 旧 family 名)解析出实际 CSS family 链。
// 未命中任何字体 → 返回 fallback。供 FontPickerPair 的预览复用。
function resolveFamilyForValue(
  value: string,
  catalog: { builtin: FontEntry[]; custom: FontEntry[]; system: FontEntry[] } | undefined,
  fallbackFamily: string,
): string {
  const generic = GENERIC_FONTS.find((g) => entryMatches(g, value));
  if (generic) return generic.family || fallbackFamily;
  if (catalog) {
    const entry = [...catalog.builtin, ...catalog.custom, ...catalog.system].find((e) =>
      entryMatches(e, value),
    );
    if (entry) return entry.family;
  }
  return fallbackFamily;
}

interface FontPickerProps {
  label: string;
  value: string;
  fallbackFamily: string;
  onChange: (value: string, family: string) => void;
  /** 单选器是否自带单行预览。被 FontPickerPair 包裹时设 false,预览由 Pair 统一渲染。 */
  showPreview?: boolean;
}

export function FontPicker({
  label,
  value,
  fallbackFamily,
  onChange,
  showPreview = true,
}: FontPickerProps) {
  const { t } = useTranslation("settings");
  const { data, isLoading } = useFontCatalog();
  const invalidate = useInvalidateFontCatalog();
  const [open, setOpen] = React.useState(false);
  const [keyword, setKeyword] = React.useState("");
  const [managerOpen, setManagerOpen] = React.useState(false);

  const kw = keyword.trim().toLowerCase();
  const matches = (text: string) => kw.length === 0 || text.toLowerCase().includes(kw);

  const allEntries = React.useMemo(
    () => [...(data?.builtin ?? []), ...(data?.custom ?? []), ...(data?.system ?? [])],
    [data],
  );

  const genericFonts = React.useMemo(
    () => GENERIC_FONTS.map((g) => ({ id: g.id, family: g.family, label: t(g.labelKey), legacyLabel: g.legacyLabel })),
    [t],
  );
  const generics = genericFonts.filter((g) => matches(g.label));
  const builtin = (data?.builtin ?? []).filter((e) => matches(e.label) || matches(e.cssName));
  const custom = (data?.custom ?? []).filter((e) => matches(e.label) || matches(e.cssName));
  const system = (data?.system ?? []).filter((e) => matches(e.label));

  const selectedEntry = React.useMemo(() => {
    const generic = genericFonts.find((g) => entryMatches(g, value));
    if (generic) return generic;
    return allEntries.find((e) => entryMatches(e, value)) ?? null;
  }, [allEntries, genericFonts, value]);

  const selectedLabel = isLoading ? t("font_picker.loading") : (selectedEntry?.label ?? t("font_picker.follow_system"));
  const previewFamily = selectedEntry ? selectedEntry.family || fallbackFamily : fallbackFamily;

  React.useEffect(() => {
    if (!open) setKeyword("");
  }, [open]);

  async function handleUploadFile(file: File) {
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.postMultipart<{ font: FontEntry }>("fonts/upload", fd);
      await invalidate();
      toast.success(t("font_picker.added_toast", { name: file.name }));
    } catch (err) {
      toast.error(extractErrorMessage(err, t("font_picker.upload_failed")));
    }
  }

  const renderRow = (id: string, lbl: string, fam: string, selected: boolean) => (
    <button
      key={id}
      type="button"
      onClick={() => {
        onChange(id, fam);
        setOpen(false);
      }}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-[var(--ds-on-surface)]",
        selected && "bg-[var(--ds-on-surface-active)]",
      )}
      style={{ fontFamily: fam || fallbackFamily }}
    >
      <span className="truncate">{lbl}</span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );

  const renderSection = (title: string, children: React.ReactNode, visible: boolean) => {
    if (!visible) return null;
    return (
      <div className="space-y-0.5">
        <div className="px-1.5 pb-0.5 pt-2 text-mini font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </div>
        {children}
      </div>
    );
  };

  const empty =
    generics.length === 0 && builtin.length === 0 && custom.length === 0 && system.length === 0;

  return (
    <div className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            disabled={isLoading}
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(96vw,24rem)] gap-0 p-0">
          <PopoverHeader className="border-b px-3 py-2.5">
            <PopoverTitle className="text-sm">{t("font_picker.pick_title")}</PopoverTitle>
          </PopoverHeader>
          <div className="px-3 py-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder={t("font_picker.search_placeholder")}
                className="h-8 pl-7 text-xs"
              />
            </div>
            <div className="mt-2 h-[20rem]">
              {empty ? (
                <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("font_picker.no_match")}
                </div>
              ) : (
                <ScrollArea className="h-full">
                  <div className="space-y-0.5 pb-2 pr-2">
                    {renderSection(
                      t("font_picker.group_generic"),
                      generics.map((g) =>
                        renderRow(g.id, g.label, g.family, entryMatches(g, value)),
                      ),
                      generics.length > 0,
                    )}
                    {renderSection(
                      t("font_picker.group_builtin"),
                      builtin.map((e) =>
                        renderRow(e.id, e.label, e.family, entryMatches(e, value)),
                      ),
                      builtin.length > 0,
                    )}
                    {renderSection(
                      t("font_picker.group_custom"),
                      custom.map((e) => renderRow(e.id, e.label, e.family, entryMatches(e, value))),
                      custom.length > 0,
                    )}
                    {renderSection(
                      t("font_picker.group_system"),
                      system.map((e) => renderRow(e.id, e.label, e.family, entryMatches(e, value))),
                      system.length > 0,
                    )}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
              <input
                type="file"
                accept={FONT_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handleUploadFile(file);
                }}
              />
              <Plus className="size-3.5" /> {t("font_picker.add_custom")}
            </label>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setManagerOpen(true);
              }}
              className="text-xs text-muted-foreground hover:underline"
            >
              {t("font_picker.manage")}
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {showPreview && (
        <div
          className="rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] px-3 py-2 text-sm"
          style={{ fontFamily: previewFamily }}
        >
          {t("font_picker.preview_sample")}
        </div>
      )}

      <FontManagerDialog
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        onChanged={invalidate}
      />
    </div>
  );
}

interface FontManagerDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

export function FontManagerDialog({ open, onClose, onChanged }: FontManagerDialogProps) {
  const { t } = useTranslation("settings");
  const { data } = useFontCatalog();
  const [uploading, setUploading] = React.useState(false);
  const [deletingName, setDeletingName] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const custom = data?.custom ?? [];

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.postMultipart<{ font: FontEntry }>("fonts/upload", fd);
      await onChanged();
      toast.success(t("font_picker.added_toast", { name: file.name }));
    } catch (err) {
      toast.error(extractErrorMessage(err, t("font_picker.upload_failed")));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(fileName: string) {
    // R8-1 同模式收口:自定义字体文件删除也是破坏性动作,必须确认
    if (!(await confirmDialog({ title: t("font_picker.delete_confirm", { name: fileName }), danger: true }))) return;
    setDeletingName(fileName);
    try {
      await api.delete(`fonts/custom/${encodeURIComponent(fileName)}`);
      await onChanged();
      toast.success(t("font_picker.deleted"));
    } catch (err) {
      toast.error(extractErrorMessage(err, t("font_picker.delete_failed")));
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("font_picker.manage")}</DialogTitle>
          <DialogDescription>
            {t("font_picker.manage_desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={FONT_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleUpload(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {t("font_picker.upload_font")}
            </Button>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{t("font_picker.uploaded_custom")}</div>
            {custom.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                {t("font_picker.no_custom")}
              </div>
            ) : (
              <ScrollArea className="max-h-72">
                <div className="space-y-1 pr-2">
                  {custom.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between gap-2 rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] px-2.5 py-1.5"
                    >
                      <span className="truncate text-sm" style={{ fontFamily: entry.family }}>
                        {entry.label}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        disabled={deletingName === entry.weights[0]?.fileName}
                        onClick={() => {
                          const fn = entry.weights[0]?.fileName;
                          if (fn) void handleDelete(fn);
                        }}
                      >
                        {deletingName === entry.weights[0]?.fileName ? (
                          <LoaderCircle className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 中英文分别设置(Word 式):英文字体 + 中文字体双栏,中文可选;下方分项预览。
// 预览三行:纯英文(用英文字体)、纯中文(用组合链)、中英混排(真实场景)。
interface FontPickerPairProps {
  label: string;
  enValue: string;
  cjkValue: string;
  fallbackFamily: string;
  /** 中文覆盖合成族名(UI_CJK_OVERRIDE_FAMILY / CHAT_CJK_OVERRIDE_FAMILY),
   *  与 root.tsx 实际渲染共用同一 @font-face(FontFaceInjector 注入),预览即所得。 */
  cjkOverrideFamily: string;
  onChangeEn: (value: string, family: string) => void;
  onChangeCjk: (value: string, family: string) => void;
}

export function FontPickerPair({
  label,
  enValue,
  cjkValue,
  fallbackFamily,
  cjkOverrideFamily,
  onChangeEn,
  onChangeCjk,
}: FontPickerPairProps) {
  const { t } = useTranslation("settings");
  const { data } = useFontCatalog();
  const enFamily = resolveFamilyForValue(enValue, data, fallbackFamily);
  const cjkFamily = resolveFamilyForValue(cjkValue, data, "");
  // 组合链(供混排行和中文行):中文覆盖族在链首拦截 CJK 字形,拉丁字形穿透到英文字体。
  // 与 root.tsx 的组合逻辑一致(lib/font-chain.ts 单一事实源)。
  const merged = composeFontChain(enFamily, cjkOverrideFamily, Boolean(cjkFamily));
  // 没设中文字体时,组合链=纯英文链,中文字形落到英文链兜底——真实反映"不分开"的效果。
  const previewRows = [
    { tag: t("font_picker.tag_en"), text: t("font_picker.preview_en_text"), family: enFamily },
    { tag: t("font_picker.tag_cjk"), text: t("font_picker.preview_cjk_text"), family: merged },
    { tag: t("font_picker.tag_mixed"), text: t("font_picker.preview_mixed_text"), family: merged },
  ];
  return (
    <div className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <FontPicker
          label={t("font_picker.tag_en")}
          value={enValue}
          fallbackFamily={fallbackFamily}
          onChange={onChangeEn}
          showPreview={false}
        />
        <FontPicker
          label={t("font_picker.tag_cjk")}
          value={cjkValue}
          fallbackFamily=""
          onChange={onChangeCjk}
          showPreview={false}
        />
      </div>
      <div className="space-y-1 rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] px-3 py-2">
        {previewRows.map((row) => (
          <div key={row.tag} className="flex items-baseline gap-2 text-sm">
            <span className="w-8 shrink-0 text-mini text-muted-foreground">{row.tag}</span>
            <span style={{ fontFamily: row.family }} className="min-w-0 truncate">
              {row.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
