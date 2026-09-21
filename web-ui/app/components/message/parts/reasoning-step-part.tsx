import * as React from "react";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import Markdown from "~/components/markdown/markdown";
import type { ReasoningPart as UIReasoningPart } from "~/types";
import Think from "~/assets/think.svg?react";
import { extractThinkingTitle } from "~/lib/utils";
import { useElapsedSeconds } from "~/hooks/use-elapsed-since";

import { useSettingsStore } from "~/stores";

import { ControlledChainOfThoughtStep } from "../chain-of-thought";

interface ReasoningStepPartProps {
  reasoning: UIReasoningPart;
  /** 消息级生成态(服务端实时真值)。思考卡的活动态由此驱动——此前用
   *  `reasoning.finishedAt == null` 推断,进程被杀遗留的孤儿思考卡会被当成
   *  "正在思考"而永远转圈/永不折叠/秒数永增;finishedAt 为 null 只代表
   *  "从未收到终局",不代表"此刻还在跑"。 */
  messageLoading?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
}

enum ReasoningCardState {
  Collapsed = "collapsed",
  Preview = "preview",
  Expanded = "expanded",
}

export function ReasoningStepPart({
  reasoning,
  messageLoading,
  isFirst,
  isLast,
}: ReasoningStepPartProps) {
  const loading = Boolean(messageLoading) && reasoning.finishedAt == null;
  const { t } = useTranslation("message");
  const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
  const [expandState, setExpandState] = React.useState<ReasoningCardState>(
    ReasoningCardState.Collapsed,
  );
  // 标题只在流式中展示:完成态(历史消息批量挂载)跳过全文逐行扫描。
  const thinkingTitle = React.useMemo(
    () => (loading ? extractThinkingTitle(reasoning.reasoning) : null),
    [loading, reasoning.reasoning],
  );
  const showThinkingTitle = loading && thinkingTitle != null;

  React.useEffect(() => {
    if (loading) {
      if (displaySetting?.showThinkingContent) {
        setExpandState((state) =>
          state === ReasoningCardState.Collapsed ? ReasoningCardState.Preview : state,
        );
      }
      return;
    }

    setExpandState((state) => {
      if (state === ReasoningCardState.Collapsed) return state;
      return (displaySetting?.autoCloseThinking ?? true)
        ? ReasoningCardState.Collapsed
        : ReasoningCardState.Expanded;
    });
  }, [
    loading,
    reasoning.reasoning,
    displaySetting?.showThinkingContent,
    displaySetting?.autoCloseThinking,
  ]);

  const onExpandedChange = (nextExpanded: boolean) => {
    if (loading) {
      setExpandState(nextExpanded ? ReasoningCardState.Expanded : ReasoningCardState.Preview);
      return;
    }

    setExpandState(nextExpanded ? ReasoningCardState.Expanded : ReasoningCardState.Collapsed);
  };

  // 耗时口径与工具卡共用(useElapsedSeconds):不足 1 秒静默、定格进位显示 1 秒、1s tick。
  // live=loading:孤儿思考卡(消息不再生成)无终点即无时长,不再对墙钟走表。
  const duration = useElapsedSeconds(reasoning.createdAt, reasoning.finishedAt, loading);

  const preview = expandState === ReasoningCardState.Preview;

  return (
    <div data-part="reasoning" data-reasoning-loading={loading || undefined}>
      <ControlledChainOfThoughtStep
        expanded={expandState === ReasoningCardState.Expanded}
        onExpandedChange={onExpandedChange}
        isFirst={isFirst}
        isLast={isLast}
        active={loading}
        icon={
          loading ? (
            <Sparkles className="h-4 w-4 animate-pulse text-primary" />
          ) : (
            <Think className="h-4 w-4 text-primary" />
          )
        }
        label={
          <span className="text-foreground text-xs font-medium">
            {showThinkingTitle
              ? thinkingTitle
              : duration !== null
                ? t("message_parts.thinking_seconds", { seconds: duration })
                : t("message_parts.deep_thinking")}
          </span>
        }
        extra={
          showThinkingTitle && duration !== null ? (
            <span className="text-muted-foreground text-xs">{duration}s</span>
          ) : undefined
        }
        contentVisible={expandState !== ReasoningCardState.Collapsed}
      >
        {/* bug3 根修之三:预览窗贴底改纯 CSS(column-reverse 天然锚定底部,内容用单一
            子元素包裹保持视觉顺序)。旧实现用效果器每个 delta 帧读 scrollHeight 再写
            scrollTop——对刚变更的大子树(思维链含代码块时是数千个 span)每帧强制一次
            同步 reflow,是"思维链流式卡、正文流式不卡"的思维链独有放大器。顺带修正
            旧行为的一个小毛病:用户在预览窗里往上翻阅时不再被每帧强行拽回底部。 */}
        <div
          className={
            preview ? "styled-scrollbar relative flex max-h-24 flex-col-reverse overflow-y-auto" : undefined
          }
        >
          <div>
            <Markdown
              content={reasoning.reasoning}
              className="reasoning-markdown text-xs !leading-[1.03125rem] [&_*]:!leading-[1.03125rem] [&_li]:mt-1 [&_ol]:my-2 [&_p+p]:mt-2 [&_p]:my-1 [&_ul]:my-2"
              isAnimating={loading}
            />
          </div>
        </div>
      </ControlledChainOfThoughtStep>
    </div>
  );
}
