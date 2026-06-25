import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

// 可折叠 JSON 树,复刻移动端 LogPage 的 JsonTree:递归渲染、默认展开前 N 层、
// 折叠时显示 `{...}(n)`、字符串值过长可点击放大、按类型着色(key 蓝/字符串绿/数字蓝/布尔橙/null 灰)。
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

function escapePreviewString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function primitiveColorClass(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "text-muted-foreground";
  if (typeof value === "string") return "text-emerald-600 dark:text-emerald-400";
  if (typeof value === "number") return "text-blue-600 dark:text-blue-400";
  if (typeof value === "boolean") return "text-orange-600 dark:text-orange-400";
  return "text-foreground";
}

interface NodeProps {
  name: string | null;
  value: JsonValue;
  depth: number;
  initialExpandDepth: number;
  onStringClick: (value: string) => void;
}

function JsonNode({ name, value, depth, initialExpandDepth, onStringClick }: NodeProps) {
  if (value !== null && value !== undefined && typeof value === "object") {
    return (
      <ContainerNode name={name} value={value as JsonValue[] | { [key: string]: JsonValue }} depth={depth} initialExpandDepth={initialExpandDepth} onStringClick={onStringClick} />
    );
  }
  const colorClass = primitiveColorClass(value);
  const isString = typeof value === "string";
  const raw = isString ? (value as string) : null;
  const display = isString ? `"${escapePreviewString(raw as string)}"` : value === null || value === undefined ? "null" : String(value);
  const zoomable = isString && (raw as string).length > 50;
  return (
    <div className="flex items-start gap-1 break-all py-0.5" style={{ paddingLeft: depth * 14 + 14 }}>
      {name !== null ? <span className="text-primary">&quot;{name}&quot;: </span> : null}
      {zoomable ? (
        <button
          type="button"
          className={cn(colorClass, "text-left underline decoration-dotted underline-offset-2 hover:rounded hover:bg-muted/50")}
          onClick={() => onStringClick(raw as string)}
        >
          {display}
        </button>
      ) : (
        <span className={colorClass}>{display}</span>
      )}
    </div>
  );
}

function ContainerNode({
  name,
  value,
  depth,
  initialExpandDepth,
  onStringClick,
}: {
  name: string | null;
  value: JsonValue[] | { [key: string]: JsonValue };
  depth: number;
  initialExpandDepth: number;
  onStringClick: (value: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(depth < initialExpandDepth);
  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as JsonValue[]).map((item, index) => [String(index), item] as const)
    : Object.entries(value as { [key: string]: JsonValue });
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex items-center gap-0.5 rounded py-0.5 hover:bg-muted/50"
        style={{ paddingLeft: depth * 14 }}
      >
        {expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
        {name !== null ? <span className="text-primary">&quot;{name}&quot;</span> : null}
        {name !== null ? <span className="text-muted-foreground">: </span> : null}
        <span className="text-muted-foreground">{expanded ? open : `${open}...${close} (${entries.length})`}</span>
      </button>
      {expanded ? (
        <>
          {entries.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child as JsonValue} depth={depth + 1} initialExpandDepth={initialExpandDepth} onStringClick={onStringClick} />
          ))}
          <div className="text-muted-foreground" style={{ paddingLeft: depth * 14 + 14 }}>
            {close}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function JsonTree({
  data,
  initialExpandDepth = 2,
  className,
  zoomTitle,
}: {
  data: unknown;
  initialExpandDepth?: number;
  className?: string;
  zoomTitle?: string;
}) {
  const [zoom, setZoom] = React.useState<string | null>(null);
  return (
    <>
      <div className={cn("overflow-x-auto font-mono text-xs leading-relaxed", className)}>
        <JsonNode name={null} value={data as JsonValue} depth={0} initialExpandDepth={initialExpandDepth} onStringClick={setZoom} />
      </div>
      <Dialog
        open={zoom !== null}
        onOpenChange={(open) => {
          if (!open) setZoom(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{zoomTitle ?? "Value"}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {zoom}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

// 把字符串尝试解析为 JSON:成功返回可喂给 JsonTree 的对象,失败返回 undefined(调用方降级为纯文本)。
export function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
