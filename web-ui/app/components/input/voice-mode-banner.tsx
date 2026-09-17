// components/input/voice-mode-banner.tsx — 语音模式横幅(免提对话状态条)
//
// 设计取向:苹果 Siri / Dynamic Island —— 居中胶囊、玻璃材质、细字重、克制的单色状态、
// 以及"活的"声纹反馈。聆听时是跳动的声波,朗读时是柔和的声波环,出错才落红色重试。
// 嵌在输入区上方(消息队列面板之上),非全屏;结束是右上角一颗安静的 X。状态由 voice-mode 单例驱动。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, X } from "lucide-react";

import { cn } from "~/lib/utils";
import { useVoiceModeState } from "~/lib/voice/voice-mode";

interface VoiceModeBannerProps {
  onEnd: () => void;
  onRetry: () => void;
}

/** 聆听声纹:五根错落跳动的细条(Siri 式)。监听时是"被听见"的核心视觉。 */
function VoiceWave({ className }: { className?: string }) {
  return (
    <span className={cn("flex h-4 items-center gap-[3px]", className)} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="vm-wave-bar" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  );
}

/** 朗读声环:两圈由内向外扩散的柔波(品牌色),表达"正在说话"。 */
function SpeakRipple() {
  return (
    <span className="relative flex size-4 items-center justify-center" aria-hidden>
      <span className="vm-ripple" />
      <span className="vm-ripple" style={{ animationDelay: "0.6s" }} />
      <span className="size-1.5 rounded-full bg-[var(--ds-brand-primary)]" />
    </span>
  );
}

export const VoiceModeBanner = React.memo(function VoiceModeBanner({ onEnd, onRetry }: VoiceModeBannerProps) {
  const { t } = useTranslation("input");
  const state = useVoiceModeState();
  const { phase } = state;

  const subtitle =
    phase === "error"
      ? t("voice.error_title")
      : phase === "connecting"
        ? t("voice.connecting")
        : phase === "listening"
          ? t("voice.listening")
          : phase === "transcribing"
            ? t("voice.transcribing")
            : phase === "speaking"
              ? t("voice.speaking")
              : "";

  // 阶段色:仅一点克制的色彩提示,主体保持单色(苹果式的"少即是多")。
  const accent =
    phase === "listening"
      ? "text-emerald-500"
      : phase === "speaking"
        ? "text-[var(--ds-brand-primary)]"
        : phase === "error"
          ? "text-destructive"
          : "text-muted-foreground";

  return (
    <div className="mb-2 flex justify-center" data-testid="voice-mode-banner">
      <div className="ds-inset-overlay vm-pill relative flex items-center gap-3 rounded-full border border-white/10 px-4 py-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
        {/* 阶段可视化:聆听=声波,朗读=声环,转写/连接=呼吸点,出错=红点。 */}
        <span className={cn("flex shrink-0 items-center", accent)}>
          {phase === "listening" ? (
            <VoiceWave />
          ) : phase === "speaking" ? (
            <SpeakRipple />
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full",
                phase === "error" ? "bg-destructive" : "bg-current vm-breathe",
              )}
            />
          )}
        </span>

        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium leading-4 text-foreground/90">{subtitle}</span>
          {state.transcript ? (
            <span className="mt-0.5 line-clamp-1 text-[12px] leading-4 text-muted-foreground/80">
              {state.transcript}
            </span>
          ) : null}
        </div>

        {phase === "error" ? (
          <button
            type="button"
            onClick={onRetry}
            className="ml-1 flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <RotateCcw className="size-3" />
            {t("voice.retry")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onEnd}
          aria-label={t("voice.end")}
          title={t("voice.end")}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
});
