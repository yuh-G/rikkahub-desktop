import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Markdown from "~/components/markdown/markdown";
import Think from "~/assets/think.svg?react";

interface ReasoningPartProps {
  reasoning: string;
  isFinished?: boolean;
}

export function ReasoningPart({ reasoning, isFinished = true }: ReasoningPartProps) {
  const [expanded, setExpanded] = React.useState(false);

  if (!reasoning) return null;

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <button
        type="button"
        className="rikkahub-step-shimmer flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground transition hover:bg-muted/50"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Think className="size-4" />
        <span>{isFinished ? "思考过程" : "正在思考"}</span>
      </button>
      {expanded && (
        <div className="border-t px-3 py-2 text-sm text-muted-foreground">
          <Markdown
            content={reasoning}
            className="reasoning-markdown text-xs !leading-[16.5px] [&_*]:!leading-[16.5px] [&_li]:mt-1 [&_ol]:my-2 [&_p+p]:mt-2 [&_p]:my-1 [&_ul]:my-2"
          />
        </div>
      )}
    </div>
  );
}
