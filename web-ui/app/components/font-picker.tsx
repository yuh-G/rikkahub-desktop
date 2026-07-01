import * as React from "react";
import { Check, ChevronDown, LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useFontCatalog, useInvalidateFontCatalog } from "~/hooks/use-font-catalog";
import { extractErrorMessage } from "~/lib/error";
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

// 通用 CSS 栈选项(无字体文件,前端固定)。id 保持稳定以兼容老用户已存的 uiFontFamily 值。
interface GenericFontOption {
  id: string;
  label: string;
  family: string;
}
const GENERIC_FONTS: GenericFontOption[] = [
  { id: "__system", label: "跟随系统", family: "" },
  {
    id: "tailwind-sans",
    label: "无衬线（系统栈）",
    family:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
  },
  {
    id: "tailwind-serif",
    label: "衬线（系统栈）",
    family: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    id: "tailwind-mono",
    label: "等宽（系统栈）",
    family:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
];

const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2,.ttc";

// 把中文字体插入英文字体 family 链(插在主字体之后)。与 root.tsx 的 mergeCjkIntoFamily 保持一致。
function mergeCjkIntoFamily(enFamily: string, cjkFamily: string): string {
  if (!cjkFamily.trim()) return enFamily.trim();
  const en = enFamily.trim();
  if (!en) return cjkFamily.trim();
  const idx = en.indexOf(",");
  return idx < 0 ? `${en}, ${cjkFamily}` : `${en.slice(0, idx)}, ${cjkFamily}${en.slice(idx)}`;
}

// 宽松匹配:容忍老版本存下来的 value(可能是 family 名、cssName 或旧 id)。
function entryMatches(
  entry: { id: string; label: string; cssName?: string },
  value: string,
): boolean {
  if (!value) return false;
  return (
    entry.id === value ||
    entry.label === value ||
    (entry.cssName != null && entry.cssName === value)
  );
}

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

  const generics = GENERIC_FONTS.filter((g) => matches(g.label));
  const builtin = (data?.builtin ?? []).filter((e) => matches(e.label) || matches(e.cssName));
  const custom = (data?.custom ?? []).filter((e) => matches(e.label) || matches(e.cssName));
  const system = (data?.system ?? []).filter((e) => matches(e.label));

  const selectedEntry = React.useMemo(() => {
    const generic = GENERIC_FONTS.find((g) => entryMatches(g, value));
    if (generic) return generic;
    return allEntries.find((e) => entryMatches(e, value)) ?? null;
  }, [allEntries, value]);

  const selectedLabel = isLoading ? "加载字体…" : (selectedEntry?.label ?? "跟随系统");
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
      toast.success(`已添加字体：${file.name}`);
    } catch (err) {
      toast.error(extractErrorMessage(err, "字体上传失败"));
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
        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-accent",
        selected && "bg-accent/60",
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
        <div className="px-1.5 pb-0.5 pt-2 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
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
            <PopoverTitle className="text-sm">选择字体</PopoverTitle>
          </PopoverHeader>
          <div className="px-3 py-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索字体…"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <div className="mt-2 h-[20rem]">
              {empty ? (
                <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                  无匹配字体
                </div>
              ) : (
                <ScrollArea className="h-full">
                  <div className="space-y-0.5 pb-2 pr-2">
                    {renderSection(
                      "通用",
                      generics.map((g) =>
                        renderRow(g.id, g.label, g.family, entryMatches(g, value)),
                      ),
                      generics.length > 0,
                    )}
                    {renderSection(
                      "应用自带",
                      builtin.map((e) =>
                        renderRow(e.id, e.label, e.family, entryMatches(e, value)),
                      ),
                      builtin.length > 0,
                    )}
                    {renderSection(
                      "自定义",
                      custom.map((e) => renderRow(e.id, e.label, e.family, entryMatches(e, value))),
                      custom.length > 0,
                    )}
                    {renderSection(
                      "系统",
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
              <Plus className="size-3.5" /> 添加自定义字体
            </label>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setManagerOpen(true);
              }}
              className="text-xs text-muted-foreground hover:underline"
            >
              管理字体
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {showPreview && (
        <div
          className="rounded-md border bg-muted/30 px-3 py-2 text-sm"
          style={{ fontFamily: previewFamily }}
        >
          RikkaHub 字体预览：你好，Hello 123
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
      toast.success(`已添加字体：${file.name}`);
    } catch (err) {
      toast.error(extractErrorMessage(err, "字体上传失败"));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(fileName: string) {
    setDeletingName(fileName);
    try {
      await api.delete(`fonts/custom/${encodeURIComponent(fileName)}`);
      await onChanged();
      toast.success("已删除");
    } catch (err) {
      toast.error(extractErrorMessage(err, "删除失败"));
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
          <DialogTitle>管理字体</DialogTitle>
          <DialogDescription>
            上传自定义字体文件（ttf / otf / woff /
            woff2），或删除已上传的字体。系统字体与应用自带字体不可在此修改。
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
              上传字体
            </Button>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">已上传的自定义字体</div>
            {custom.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                还没有自定义字体
              </div>
            ) : (
              <ScrollArea className="max-h-72">
                <div className="space-y-1 pr-2">
                  {custom.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
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
// 预览三行:纯英文(用英文字体)、纯中文(用合并链,没设中文时回退)、中英混排(真实场景)。
interface FontPickerPairProps {
  label: string;
  enValue: string;
  cjkValue: string;
  fallbackFamily: string;
  onChangeEn: (value: string, family: string) => void;
  onChangeCjk: (value: string, family: string) => void;
}

export function FontPickerPair({
  label,
  enValue,
  cjkValue,
  fallbackFamily,
  onChangeEn,
  onChangeCjk,
}: FontPickerPairProps) {
  const { data } = useFontCatalog();
  const enFamily = resolveFamilyForValue(enValue, data, fallbackFamily);
  const cjkFamily = resolveFamilyForValue(cjkValue, data, "");
  // 合并链(供混排行和中文行):英文主字体 + 中文字体 + 兜底。与 root.tsx 的合并逻辑一致。
  const merged = mergeCjkIntoFamily(enFamily, cjkFamily);
  // 中文行:有中文字体时用合并链(英文部分会回退,但中文行内容是纯中文,实际渲染中文字体);
  // 没设中文字体时,中文行用合并链=纯英文链,中文字形落到兜底——真实反映"不分开"的效果。
  const previewRows = [
    { tag: "英文", text: "The quick brown fox jumps 0123456789", family: enFamily },
    { tag: "中文", text: "你好,世界。春江潮水连海平,海上明月共潮生。", family: merged },
    { tag: "混排", text: "Hello 你好,这是 RikkaHub 2026 年的测试 Test 测试。", family: merged },
  ];
  return (
    <div className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <FontPicker
          label="英文"
          value={enValue}
          fallbackFamily={fallbackFamily}
          onChange={onChangeEn}
          showPreview={false}
        />
        <FontPicker
          label="中文"
          value={cjkValue}
          fallbackFamily=""
          onChange={onChangeCjk}
          showPreview={false}
        />
      </div>
      <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2">
        {previewRows.map((row) => (
          <div key={row.tag} className="flex items-baseline gap-2 text-sm">
            <span className="w-8 shrink-0 text-[0.6875rem] text-muted-foreground">{row.tag}</span>
            <span style={{ fontFamily: row.family }} className="min-w-0 truncate">
              {row.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
