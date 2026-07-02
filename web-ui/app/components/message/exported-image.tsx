import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Brain,
  FileText,
  Film,
  Globe,
  Music,
  Search,
  Wrench,
} from "lucide-react";

import Markdown from "~/components/markdown/markdown";
import { AIIcon } from "~/components/ui/ai-icon";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { useSettingsStore } from "~/stores";
import type {
  AssistantAvatar,
  MessageDto,
  ProviderModel,
  ProviderProfile,
  ToolPart,
  UIMessagePart,
} from "~/types";

export interface ExportedImageProps {
  title: string;
  messages: MessageDto[];
  expandReasoning: boolean;
}

// 浅色主题变量。导出图始终用浅色, 不跟随 app 当前明暗 —— 分享到微信等场景下浅色更易读,
// 也避免暗色导出图在浅色背景里发糊。通过内联 CSS 变量覆盖 :root 声明, 子树内所有
// var(--xxx) 取这套浅色值 (CSS 变量按 DOM 树继承, 最近的祖先声明优先)。
const LIGHT_VARS = {
  "--background": "0 0% 100%",
  "--foreground": "222.2 47.4% 11.2%",
  "--card": "0 0% 100%",
  "--card-foreground": "222.2 47.4% 11.2%",
  "--popover": "0 0% 100%",
  "--popover-foreground": "222.2 47.4% 11.2%",
  "--muted": "210 40% 96.1%",
  "--muted-foreground": "215.4 16.3% 46.9%",
  "--accent": "210 40% 94%",
  "--accent-foreground": "222.2 47.4% 11.2%",
  "--border": "214.3 31.8% 91.4%",
  "--input": "214.3 31.8% 91.4%",
  "--primary": "222.2 47.4% 11.2%",
  "--primary-foreground": "210 40% 98%",
  "--secondary": "210 40% 96.1%",
  "--secondary-foreground": "222.2 47.4% 11.2%",
  "--ring": "215 20.2% 65.1%",
} as React.CSSProperties;

// app logo(Vite public 目录, 构建后是 /app-icon.png)。导出图头部右侧的品牌标识。
const APP_ICON_SRC = "/app-icon.png";

function findModel(
  modelId: string | null | undefined,
  providers: ProviderProfile[] | undefined,
): ProviderModel | null {
  if (!modelId || !providers) return null;
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if (model.id === modelId || model.modelId === modelId) {
        return model;
      }
    }
  }
  return null;
}

function isExportable(part: UIMessagePart): boolean {
  switch (part.type) {
    case "text":
      return part.text.trim().length > 0;
    case "image":
      return part.url.trim().length > 0;
    case "reasoning":
      return part.reasoning.trim().length > 0;
    case "document":
      return part.fileName.trim().length > 0 || part.url.trim().length > 0;
    case "video":
    case "audio":
      return part.url.trim().length > 0;
    case "tool":
      return true;
    default:
      return false;
  }
}

// reasoning 时长(秒)。finishedAt 缺省时用现在相对 createdAt。
function reasoningSeconds(createdAt?: string, finishedAt?: string | null): number | null {
  const start = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(end) || end <= start) return null;
  return Math.max(0.1, (end - start) / 1000);
}

function ToolIcon({ toolName }: { toolName: string }) {
  const cls = "size-3.5 shrink-0";
  switch (toolName) {
    case "search_web":
      return <Search className={cls} />;
    case "scrape_web":
      return <Globe className={cls} />;
    case "memory_tool":
      return <Brain className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

// 工具卡片的简短标签:与主界面 ToolStepPart 同源语义,但导出图只展示标题不展开参数/结果,
// 保持长图紧凑。search_web 带上 query,其它只显示本地化工具名。
function toolCardLabel(tool: ToolPart, t: (k: string, p?: Record<string, unknown>) => string): string {
  switch (tool.toolName) {
    case "search_web": {
      let query = "";
      try {
        const input = JSON.parse(tool.input);
        query = typeof input.query === "string" ? input.query : "";
      } catch {
        // ignore
      }
      return query
        ? t("tool_part.search_web_with_query", { query })
        : t("tool_part.search_web");
    }
    case "scrape_web":
      return t("tool_part.scrape_web");
    case "memory_tool": {
      let action = "";
      try {
        const input = JSON.parse(tool.input);
        action = typeof input.action === "string" ? input.action : "";
      } catch {
        // ignore
      }
      if (action === "create") return t("tool_part.memory_create");
      if (action === "edit") return t("tool_part.memory_edit");
      if (action === "delete") return t("tool_part.memory_delete");
      return t("tool_part.tool_call_with_name", { toolName: tool.toolName });
    }
    default:
      return t("tool_part.tool_call_with_name", { toolName: tool.toolName });
  }
}

export const ExportedImage = React.forwardRef<HTMLDivElement, ExportedImageProps>(
  function ExportedImage({ title, messages, expandReasoning }, ref) {
    const providers = useSettingsStore((state) => state.settings?.providers);
    const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
    const { t } = useTranslation("message");

    const userName =
      displaySetting?.userNickname?.trim() || t("chat_message.md_role_user");
    const userAvatar: AssistantAvatar | undefined = displaySetting?.userAvatar;
    const showAssistantBubble = displaySetting?.showAssistantBubble === true;
    const fontFamily =
      displaySetting?.chatFontFamilyCss?.trim() ||
      displaySetting?.uiFontFamilyCss?.trim() ||
      "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";

    return (
      <div
        ref={ref}
        style={{
          ...LIGHT_VARS,
          width: 560,
          boxSizing: "border-box",
          // 顶部带极浅主题色渐变,纯白会显得空洞;渐变在 200px 内过渡到白,不影响阅读
          background:
            "linear-gradient(180deg, hsl(214 40% 97%) 0%, hsl(0 0% 100%) 180px)",
          color: "hsl(var(--foreground))",
          padding: 28,
          fontFamily,
          fontSize: 14,
          lineHeight: 1.7,
        }}
      >
        {/* 头部:标题 + 导出时间 + app logo */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            paddingBottom: 16,
            marginBottom: 20,
            borderBottom: "1px solid hsl(var(--border))",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: "hsl(var(--foreground))",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {title?.trim() || t("chat_message.share_dialog_title")}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "hsl(var(--muted-foreground))",
                marginTop: 4,
              }}
            >
              {new Date().toLocaleString()} · Rikkahub
            </div>
          </div>
          <img
            src={APP_ICON_SRC}
            alt="Rikkahub"
            crossOrigin="anonymous"
            style={{ width: 44, height: 44, borderRadius: 10, objectFit: "cover" }}
          />
        </header>

        {/* 消息列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {messages.map((message, idx) => (
            <ExportedMessage
              key={message.id}
              message={message}
              expandReasoning={expandReasoning}
              model={findModel(message.modelId, providers)}
              prevMessage={messages[idx - 1]}
              isUser={message.role === "USER"}
              showAssistantBubble={showAssistantBubble}
              userName={userName}
              userAvatar={userAvatar}
              t={t}
            />
          ))}
        </div>

        {/* 水印 */}
        <div
          style={{
            marginTop: 24,
            paddingTop: 14,
            borderTop: "1px solid hsl(var(--border))",
            fontSize: 11,
            color: "hsl(var(--muted-foreground))",
            textAlign: "center",
            opacity: 0.8,
          }}
        >
          {t("chat_message.export_image_watermark", "由 Rikkahub 生成 · rikka-ai.com")}
        </div>
      </div>
    );
  },
);

interface ExportedMessageProps {
  message: MessageDto;
  expandReasoning: boolean;
  model: ProviderModel | null;
  prevMessage?: MessageDto;
  isUser: boolean;
  showAssistantBubble: boolean;
  userName: string;
  userAvatar?: AssistantAvatar;
  t: (k: string, p?: Record<string, unknown>) => string;
}

function ExportedMessage({
  message,
  expandReasoning,
  model,
  prevMessage,
  isUser,
  showAssistantBubble,
  userName,
  userAvatar,
  t,
}: ExportedMessageProps) {
  const parts = message.parts.filter(isExportable);
  // 助手在"紧跟用户提问"时显示模型名(对齐 APP showModelIcon 逻辑),连续多条助手回复只在第一条带名。
  const showModelHeader = !isUser && (!prevMessage || prevMessage.role === "USER");
  const modelName = model?.displayName?.trim() || model?.modelId?.trim() || t("chat_message.md_role_assistant");

  const bubbleStyle: React.CSSProperties = isUser
    ? {
        backgroundColor: "hsl(var(--muted))",
        borderRadius: 16,
        borderBottomRightRadius: 6,
        padding: "10px 14px",
      }
    : showAssistantBubble
      ? {
          backgroundColor: "hsl(var(--secondary))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 16,
          padding: "10px 14px",
        }
      : {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 头像 + 名字行 */}
      {isUser ? (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "hsl(var(--foreground))" }}>
            {userName}
          </span>
          <UIAvatar name={userName} avatar={userAvatar} size="sm" />
        </div>
      ) : showModelHeader ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AIIcon name={model?.modelId || "AI"} size={32} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "hsl(var(--foreground))" }}>
            {modelName}
          </span>
        </div>
      ) : null}

      {/* 内容 */}
      <div
        style={{
          display: "flex",
          width: "100%",
          justifyContent: isUser ? "flex-end" : "flex-start",
        }}
      >
        <div
          style={{
            maxWidth: "92%",
            width: isUser ? "fit-content" : "100%",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            ...bubbleStyle,
          }}
        >
          {parts.map((part, i) => (
            <PartView
              key={i}
              part={part}
              expandReasoning={expandReasoning}
              isUser={isUser}
              t={t}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PartView({
  part,
  expandReasoning,
  isUser,
  t,
}: {
  part: UIMessagePart;
  expandReasoning: boolean;
  isUser: boolean;
  t: (k: string, p?: Record<string, unknown>) => string;
}) {
  if (part.type === "text") {
    return <Markdown content={part.text} className="message-markdown" />;
  }
  if (part.type === "reasoning" && expandReasoning) {
    return (
      <ReasoningCard
        reasoning={part.reasoning}
        seconds={reasoningSeconds(part.createdAt, part.finishedAt)}
        t={t}
      />
    );
  }
  if (part.type === "tool") {
    return <ToolCard tool={part} t={t} />;
  }
  if (part.type === "image") {
    return (
      <img
        src={part.url}
        alt={t("chat_message.copy_image")}
        crossOrigin="anonymous"
        style={{
          maxWidth: "100%",
          maxHeight: 320,
          borderRadius: 10,
          display: "block",
        }}
      />
    );
  }
  if (part.type === "document") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid hsl(var(--border))",
          borderRadius: 10,
          padding: "8px 12px",
          fontSize: 13,
          color: "hsl(var(--muted-foreground))",
        }}
      >
        <FileText className="size-4 shrink-0" />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {part.fileName || t("chat_message.copy_document")}
        </span>
      </div>
    );
  }
  if (part.type === "video") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid hsl(var(--border))",
          borderRadius: 10,
          padding: "8px 12px",
          fontSize: 13,
          color: "hsl(var(--muted-foreground))",
        }}
      >
        <Film className="size-4 shrink-0" />
        <span>{t("chat_message.copy_video")}</span>
      </div>
    );
  }
  if (part.type === "audio") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid hsl(var(--border))",
          borderRadius: 10,
          padding: "8px 12px",
          fontSize: 13,
          color: "hsl(var(--muted-foreground))",
        }}
      >
        <Music className="size-4 shrink-0" />
        <span>{t("chat_message.copy_audio")}</span>
      </div>
    );
  }
  return null;
}

function ReasoningCard({
  reasoning,
  seconds,
  t,
}: {
  reasoning: string;
  seconds: number | null;
  t: (k: string, p?: Record<string, unknown>) => string;
}) {
  return (
    <div
      style={{
        borderLeft: "3px solid hsl(var(--primary))",
        backgroundColor: "hsl(var(--muted))",
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 13,
        color: "hsl(var(--muted-foreground))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        <Brain className="size-3.5 shrink-0" />
        <span>{t("message_parts.deep_thinking")}</span>
        {seconds != null ? (
          <span style={{ fontWeight: 400 }}>
            · {t("message_parts.thinking_seconds", { seconds: seconds.toFixed(1) })}
          </span>
        ) : null}
      </div>
      <Markdown content={reasoning} className="message-markdown" />
    </div>
  );
}

function ToolCard({
  tool,
  t,
}: {
  tool: ToolPart;
  t: (k: string, p?: Record<string, unknown>) => string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        backgroundColor: "hsl(var(--accent))",
        borderRadius: 8,
        padding: "6px 10px",
        fontSize: 13,
        color: "hsl(var(--accent-foreground))",
      }}
    >
      <ToolIcon toolName={tool.toolName} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {toolCardLabel(tool, t)}
      </span>
    </div>
  );
}
