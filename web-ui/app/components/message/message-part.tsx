import * as React from "react";
import { useTranslation } from "react-i18next";

import type { ReasoningPart, ToolPart, UIMessagePart } from "~/types";
import type { AssistantProfile } from "~/types";

import { ChainOfThought } from "./chain-of-thought";
import { AudioPart } from "./parts/audio-part";
import { DocumentPart } from "./parts/document-part";
import { ImagePart } from "./parts/image-part";
import { ReasoningPart as ReasoningFallbackPart } from "./parts/reasoning-part";
import { ReasoningStepPart } from "./parts/reasoning-step-part";
import { TextPart } from "./parts/text-part";
import { ToolPart as ToolStepPart } from "./parts/tool-part";
import { VideoPart } from "./parts/video-part";
import { TypingIndicator } from "~/components/ui/typing-indicator";
import { applyAssistantRegexes } from "~/lib/assistant-regex";

type ThinkingStep =
  | {
      type: "reasoning";
      reasoning: ReasoningPart;
    }
  | {
      type: "tool";
      tool: ToolPart;
    };

type MessagePartBlock =
  | {
      type: "thinking";
      steps: ThinkingStep[];
    }
  | {
      type: "content";
      part: UIMessagePart;
      index: number;
    };

export function groupMessageParts(parts: UIMessagePart[]): MessagePartBlock[] {
  const result: MessagePartBlock[] = [];
  let currentThinkingSteps: ThinkingStep[] = [];

  const flushThinkingSteps = () => {
    if (currentThinkingSteps.length === 0) return;
    result.push({ type: "thinking", steps: currentThinkingSteps });
    currentThinkingSteps = [];
  };

  parts.forEach((part, index) => {
    if (part.type === "loading") {
      flushThinkingSteps();
      result.push({ type: "content", part, index });
      return;
    }

    if (part.type === "reasoning") {
      currentThinkingSteps.push({ type: "reasoning", reasoning: part });
      return;
    }

    if (part.type === "tool") {
      currentThinkingSteps.push({ type: "tool", tool: part });
      return;
    }

    flushThinkingSteps();
    result.push({ type: "content", part, index });
  });

  flushThinkingSteps();
  return result;
}

interface MessagePartsProps {
  parts: UIMessagePart[];
  loading?: boolean;
  assistant?: AssistantProfile | null;
  role?: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  onToolApproval?: (toolCallId: string, approved: boolean, reason: string, answer?: string) => void | Promise<void>;
  onClickCitation?: (id: string) => void;
}

function renderContentPart(
  part: UIMessagePart,
  t: (key: string, options?: Record<string, unknown>) => string,
  loading?: boolean,
  onClickCitation?: (id: string) => void,
  assistant?: AssistantProfile | null,
  role?: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL",
) {
  switch (part.type) {
    case "text":
      return <TextPart text={applyAssistantRegexes(part.text, assistant, role === "USER" ? "USER" : "ASSISTANT", true)} isAnimating={loading} onClickCitation={onClickCitation} />;
    case "image":
      return <ImagePart url={part.url} metadata={part.metadata} />;
    case "video":
      return <VideoPart url={part.url} />;
    case "audio":
      return <AudioPart url={part.url} />;
    case "document":
      return <DocumentPart url={part.url} fileName={part.fileName} mime={part.mime} />;
    case "reasoning":
      return (
        <ReasoningFallbackPart reasoning={part.reasoning} isFinished={part.finishedAt != null} />
      );
    case "tool":
      return (
        <div className="text-xs text-muted-foreground">{t("message_parts.tool_step_hint")}</div>
      );
    case "loading":
      return <TypingIndicator className="px-1 py-2" />;
  }
}

export const MessageParts = React.memo(({
  parts,
  loading = false,
  assistant,
  role,
  onToolApproval,
  onClickCitation,
}: MessagePartsProps) => {
  const { t } = useTranslation("message");
  const groupedParts = React.useMemo(() => groupMessageParts(parts), [parts]);
  const hasContentPart = React.useMemo(
    () =>
      parts.some((part) => {
        if (part.type === "text") return part.text.trim().length > 0;
        if (part.type === "image" || part.type === "video" || part.type === "audio") return part.url.trim().length > 0;
        if (part.type === "document") return part.url.trim().length > 0 || part.fileName.trim().length > 0;
        if (part.type === "loading") return false;
        return false;
      }),
    [parts],
  );
  // The backend inserts a `{type:"loading"}` placeholder while waiting for the first chunk; that
  // part already renders a TypingIndicator below, so the fallback waiting indicator would double
  // up when the only "part" is the placeholder. Treat the placeholder as the visible indicator.
  const hasLoadingPart = React.useMemo(
    () => parts.some((part) => part.type === "loading"),
    [parts],
  );
  const showWaitingIndicator = loading && !hasContentPart && !hasLoadingPart;

  return (
    <>
      {loading && parts.length === 0 ? <TypingIndicator className="px-1 py-2" /> : null}
      {groupedParts.map((block, blockIndex) => {
        if (block.type === "thinking") {
          if (block.steps.length === 0) return null;

          const isReasoningOnlyBlock = block.steps.every((step) => step.type === "reasoning");
          const hasLoadingReasoning = block.steps.some(
            (step) => step.type === "reasoning" && step.reasoning.finishedAt == null,
          );
          const enableAdaptiveWidth = isReasoningOnlyBlock && !hasLoadingReasoning;

          return (
            <ChainOfThought
              key={`thinking-${blockIndex}`}
              className="my-1"
              collapsedAdaptiveWidth={enableAdaptiveWidth}
              collapseLabel={t("message_parts.collapse_thinking")}
              showMoreLabel={(hiddenCount) =>
                t("message_parts.expand_thinking_steps", { count: hiddenCount })
              }
              steps={block.steps}
              renderStep={(step, stepIndex, { isFirst, isLast }) => {
                if (step.type === "reasoning") {
                  const stepKey = step.reasoning.createdAt ?? `${blockIndex}-${stepIndex}`;
                  return (
                    <ReasoningStepPart
                      key={stepKey}
                      reasoning={step.reasoning}
                      collapsedAdaptiveWidth={enableAdaptiveWidth}
                      isFirst={isFirst}
                      isLast={isLast}
                    />
                  );
                }

                const stepKey = step.tool.toolCallId || `${blockIndex}-${stepIndex}`;
                return (
                  <ToolStepPart
                    key={stepKey}
                    tool={step.tool}
                    loading={loading && step.tool.output.length === 0}
                    onToolApproval={onToolApproval}
                    isFirst={isFirst}
                    isLast={isLast}
                  />
                );
              }}
            />
          );
        }

        return (
          <React.Fragment key={`content-${block.index}`}>
            {renderContentPart(block.part, t, loading, onClickCitation, assistant, role)}
          </React.Fragment>
        );
      })}
      {showWaitingIndicator && parts.length > 0 ? <TypingIndicator className="px-1 py-2" /> : null}
    </>
  );
});

interface MessagePartProps {
  part: UIMessagePart;
  loading?: boolean;
  assistant?: AssistantProfile | null;
  role?: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  onToolApproval?: (toolCallId: string, approved: boolean, reason: string, answer?: string) => void | Promise<void>;
  onClickCitation?: (id: string) => void;
}

export function MessagePart({ part, loading, assistant, role, onToolApproval, onClickCitation }: MessagePartProps) {
  return (
    <MessageParts
      parts={[part]}
      loading={loading}
      assistant={assistant}
      role={role}
      onToolApproval={onToolApproval}
      onClickCitation={onClickCitation}
    />
  );
}
