// components/settings/shared.tsx — 设置页各分区共用的小组件与工具（纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, GripVertical } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return items;
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return items;
  next.splice(toIndex, 0, item);
  return next;
}

export function numberText(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

export function PasswordInput({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute top-1/2 right-1 -translate-y-1/2"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? t("settings:common.hide_key") : t("settings:common.show_key")}
        title={visible ? t("settings:common.hide_key") : t("settings:common.show_key")}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

export function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <div className="rounded-md border bg-card p-2">
        <Icon className="size-5" />
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

export function SortableRow({
  id,
  index,
  active,
  children,
  onSelect,
  onMove,
}: {
  id: string;
  index: number;
  active?: boolean;
  children: React.ReactNode;
  onSelect?: () => void;
  onMove?: (from: number, to: number) => void;
}) {
  const [over, setOver] = React.useState(false);
  const canMove = typeof onMove === "function";
  return (
    <div
      draggable={canMove}
      onDragStart={(event) => {
        if (!canMove) return;
        event.dataTransfer.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!canMove) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        if (canMove) setOver(false);
      }}
      onDrop={(event) => {
        if (!canMove) return;
        event.preventDefault();
        setOver(false);
        const from = Number(event.dataTransfer.getData("text/plain"));
        if (Number.isFinite(from)) onMove?.(from, index);
      }}
      className={[
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition",
        // 选中行别用 bg-accent 实填:部分主题把 accent 登记成满饱和点缀色
        // (mx-brutalist 的橙),整行橙块砸在列表里;中性晕染任何主题都成立。
        active ? "bg-[var(--ds-on-surface-active)]" : "hover:bg-[var(--ds-on-surface)]",
        over ? "ring-2 ring-primary/40" : "",
      ].join(" ")}
      data-sort-id={id}
    >
      {canMove ? (
        <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
      ) : null}
      <button type="button" className="min-w-0 flex-1" onClick={onSelect}>
        {children}
      </button>
    </div>
  );
}
