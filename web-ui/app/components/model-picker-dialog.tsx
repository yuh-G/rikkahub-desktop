import * as React from "react";
import { Check, Plus, Search, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import type { ProviderModel } from "~/types/settings";

export interface ModelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All models fetched from the upstream provider's /v1/models endpoint. */
  fetchedModels: ProviderModel[];
  /** Models already enabled (in draft.models). Used to pre-check rows. */
  enabledModelIds: Set<string>;
  /** Called when the user confirms their selection. */
  onConfirm: (selected: ProviderModel[]) => void;
  /** Opens the manual-add dialog for models not in the fetched list. */
  onManualAdd: () => void;
  /** Whether models are currently being fetched. */
  loading?: boolean;
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  fetchedModels,
  enabledModelIds,
  onConfirm,
  onManualAdd,
  loading,
}: ModelPickerDialogProps) {
  const [search, setSearch] = React.useState("");
  // Track which modelIds the user has checked locally (starts from enabledModelIds).
  const [checked, setChecked] = React.useState<Set<string>>(new Set());

  // Reset local selection whenever the dialog opens or fetchedModels change.
  React.useEffect(() => {
    if (open) {
      setChecked(new Set(enabledModelIds));
      setSearch("");
    }
  }, [open, enabledModelIds]);

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return fetchedModels;
    return fetchedModels.filter(
      (model) =>
        (model.modelId ?? "").toLowerCase().includes(query) ||
        (model.displayName ?? "").toLowerCase().includes(query),
    );
  }, [fetchedModels, search]);

  const allFilteredChecked =
    filtered.length > 0 && filtered.every((model) => checked.has(model.modelId));

  const toggle = (modelId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const toggleAll = () => {
    if (allFilteredChecked) {
      // Uncheck all filtered
      setChecked((prev) => {
        const next = new Set(prev);
        for (const model of filtered) next.delete(model.modelId);
        return next;
      });
    } else {
      // Check all filtered
      setChecked((prev) => {
        const next = new Set(prev);
        for (const model of filtered) next.add(model.modelId);
        return next;
      });
    }
  };

  const handleConfirm = () => {
    const selected = fetchedModels.filter((model) => checked.has(model.modelId));
    onConfirm(selected);
    onOpenChange(false);
  };

  const handleManualAdd = () => {
    onOpenChange(false);
    onManualAdd();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>选择模型</DialogTitle>
          <DialogDescription>
            从上游供应商获取到的模型列表中选择要启用的模型。使用搜索快速定位。
          </DialogDescription>
        </DialogHeader>

        {/* Search bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索模型名称或 ID…"
            className="pl-9 pr-8"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>

        {/* Toggle-all + count */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div
            role="button"
            tabIndex={0}
            onClick={toggleAll}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleAll();
              }
            }}
            className="flex items-center gap-1 hover:text-foreground transition cursor-pointer"
          >
            <Checkbox checked={allFilteredChecked} className="pointer-events-none size-3.5" />
            {allFilteredChecked ? "取消全选" : "全选"}
          </div>
          <span>
            {checked.size} / {fetchedModels.length} 个已选
          </span>
        </div>

        {/* Model list */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            正在获取模型列表…
          </div>
        ) : fetchedModels.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
            还没有获取到模型列表。请检查供应商配置后重试。
            <Button variant="outline" size="sm" onClick={handleManualAdd}>
              <Plus className="size-3.5" />
              手动添加
            </Button>
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="space-y-1 pr-2">
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  没有匹配的模型
                </div>
              ) : (
                filtered.map((model) => {
                  const isChecked = checked.has(model.modelId);
                  return (
                    <div
                      key={model.id ?? model.modelId}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggle(model.modelId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggle(model.modelId);
                        }
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition hover:bg-muted/60",
                        isChecked && "bg-primary/5",
                      )}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggle(model.modelId)}
                        onClick={(event) => event.stopPropagation()}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {model.displayName || model.modelId}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {model.modelId}
                        </span>
                      </span>
                      {isChecked ? (
                        <Check className="size-4 shrink-0 text-primary" />
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        )}

        {/* Manual add link */}
        <div className="text-center">
          <button
            type="button"
            onClick={handleManualAdd}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition"
          >
            模型不在列表里？手动添加
          </button>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={loading}>
            确认添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
