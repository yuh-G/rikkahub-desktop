import * as React from "react";

import Markdown from "~/components/markdown/markdown";
import { useSettingsStore } from "~/stores";
import type { MessageDto, ProviderProfile, UIMessagePart } from "~/types";

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

function findModelDisplayName(
  modelId: string | null | undefined,
  providers: ProviderProfile[] | undefined,
): string | null {
  if (!modelId || !providers) return null;
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if (model.id === modelId || model.modelId === modelId) {
        return model.displayName || model.modelId || null;
      }
    }
  }
  return null;
}

function isRenderable(part: UIMessagePart): boolean {
  if (part.type === "text") return part.text.trim().length > 0;
  if (part.type === "image") return part.url.trim().length > 0;
  if (part.type === "reasoning") return part.reasoning.trim().length > 0;
  return false;
}

export const ExportedImage = React.forwardRef<HTMLDivElement, ExportedImageProps>(
  function ExportedImage({ title, messages, expandReasoning }, ref) {
    const providers = useSettingsStore((state) => state.settings?.providers);
    return (
      <div
        ref={ref}
        style={{
          ...LIGHT_VARS,
          width: 520,
          boxSizing: "border-box",
          backgroundColor: "#ffffff",
          color: "#1a1a2e",
          padding: 24,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        {/* 头部:标题 + 导出时间 + 水印 */}
        <div
          style={{
            paddingBottom: 14,
            marginBottom: 16,
            borderBottom: "1px solid hsl(var(--border))",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700, color: "#111" }}>
            {title?.trim() || "对话"}
          </div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            {new Date().toLocaleString()} · Rikkahub
          </div>
        </div>

        {/* 消息列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {messages.map((message, idx) => (
            <ExportedMessage
              key={message.id}
              message={message}
              expandReasoning={expandReasoning}
              modelName={findModelDisplayName(message.modelId, providers)}
              prevMessage={messages[idx - 1]}
            />
          ))}
        </div>

        <div
          style={{
            marginTop: 24,
            paddingTop: 12,
            borderTop: "1px solid hsl(var(--border))",
            fontSize: 11,
            color: "#bbb",
            textAlign: "center",
          }}
        >
          由 Rikkahub 生成
        </div>
      </div>
    );
  },
);

function ExportedMessage({
  message,
  expandReasoning,
  modelName,
  prevMessage,
}: {
  message: MessageDto;
  expandReasoning: boolean;
  modelName: string | null;
  prevMessage?: MessageDto;
}) {
  const isUser = message.role === "USER";
  // 助手在"紧跟用户提问"时显示模型名 (对齐 APP showModelIcon 逻辑), 连续多条助手回复只在第一条带名。
  const showModelHeader = !isUser && prevMessage?.role === "USER";
  const parts = message.parts.filter(isRenderable);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: isUser ? "flex-end" : "flex-start",
      }}
    >
      {showModelHeader && modelName ? (
        <div style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>{modelName}</div>
      ) : null}
      <div style={{ maxWidth: "92%", width: isUser ? "fit-content" : "100%" }}>
        {parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <div
                key={i}
                style={{
                  padding: isUser ? "8px 12px" : 0,
                  backgroundColor: isUser ? "#f1f1f4" : "transparent",
                  borderRadius: isUser ? 12 : 0,
                }}
              >
                <Markdown content={part.text} className="message-markdown" />
              </div>
            );
          }
          if (part.type === "reasoning" && expandReasoning) {
            return (
              <div
                key={i}
                style={{
                  borderLeft: "3px solid #d0d0d4",
                  padding: "8px 12px",
                  margin: "4px 0",
                  fontSize: 13,
                  color: "#666",
                  backgroundColor: "#fafafa",
                  borderRadius: 4,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4, color: "#888" }}>思考</div>
                <Markdown content={part.reasoning} className="message-markdown" />
              </div>
            );
          }
          if (part.type === "image") {
            return (
              <img
                key={i}
                src={part.url}
                style={{
                  maxWidth: "100%",
                  borderRadius: 8,
                  marginTop: 8,
                  display: "block",
                }}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
