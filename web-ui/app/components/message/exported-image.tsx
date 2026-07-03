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

// 导出图根要承接的 :root CSS 变量名。运行时从 documentElement 的 computed style 读取,
// 把"当前主题(明暗 + 主题色)"原样搬到导出图根上。这样子树里所有 var(--xxx) 都与应用
// 所见一致 —— 表格边框/斑马纹、blockquote 引用线、citation 徽章背景、代码块边框等,
// 不再因写死浅色变量(HSL 通道值与 app.css 的 oklch 直接值格式不匹配)而失效;并且天然
// 跟随用户当前选中的主题色与明暗模式,导出图就是用户在应用里看到的样子。
const THEME_VAR_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--ring",
  "--destructive",
  "--destructive-foreground",
] as const;

function readThemeVars(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const computed = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of THEME_VAR_NAMES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  return vars;
}

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
    // 挂载时读一次当前主题变量。分享对话框是模态的,用户不会同时切主题,单次读取足够。
    const themeVars = React.useMemo(() => readThemeVars(), []);

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
          ...themeVars,
          width: 960,
          boxSizing: "border-box",
          // 顶部带极淡 muted 渐变过渡到 background —— 纯色会显得空洞。用 color-mix 让
          // 浅色/暗色主题都自然:muted 在浅色是浅灰、暗色是深灰,混入 background 即得
          // 略亮于背景的顶部色调,过渡后回归纯 background。color-mix(in oklch) 在
          // Chromium 111+ 支持,WebView2 与现代浏览器均覆盖。
          background:
            "linear-gradient(180deg, color-mix(in oklch, var(--muted) 45%, var(--background)) 0%, var(--background) 280px)",
          color: "var(--foreground)",
          padding: 40,
          fontFamily,
          fontSize: 15,
          lineHeight: 1.75,
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
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "var(--foreground)",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {title?.trim() || t("chat_message.share_dialog_title")}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--muted-foreground)",
                marginTop: 4,
              }}
            >
              {new Date().toLocaleString()} · Rikkahub Desktop
            </div>
          </div>
          <img
            src={APP_ICON_SRC}
            alt="Rikkahub Desktop"
            crossOrigin="anonymous"
            style={{ width: 48, height: 48, borderRadius: 12, objectFit: "cover" }}
          />
        </header>

        {/* 消息列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
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
            borderTop: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--muted-foreground)",
            textAlign: "center",
            opacity: 0.8,
          }}
        >
          {t("chat_message.export_image_watermark")}
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
        backgroundColor: "var(--muted)",
        borderRadius: 16,
        borderBottomRightRadius: 6,
        padding: "12px 16px",
      }
    : showAssistantBubble
      ? {
          backgroundColor: "var(--secondary)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: "12px 16px",
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
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>
            {userName}
          </span>
          <UIAvatar name={userName} avatar={userAvatar} size="sm" />
        </div>
      ) : showModelHeader ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AIIcon name={model?.modelId || "AI"} size={32} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>
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
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "8px 12px",
          fontSize: 14,
          color: "var(--muted-foreground)",
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
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "8px 12px",
          fontSize: 14,
          color: "var(--muted-foreground)",
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
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "8px 12px",
          fontSize: 14,
          color: "var(--muted-foreground)",
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
        borderLeft: "3px solid var(--primary)",
        backgroundColor: "var(--muted)",
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 14,
        color: "var(--muted-foreground)",
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
        backgroundColor: "var(--accent)",
        borderRadius: 8,
        padding: "6px 10px",
        fontSize: 14,
        color: "var(--accent-foreground)",
      }}
    >
      <ToolIcon toolName={tool.toolName} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {toolCardLabel(tool, t)}
      </span>
    </div>
  );
}
