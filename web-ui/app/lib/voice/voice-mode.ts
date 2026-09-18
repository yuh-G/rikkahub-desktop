// lib/voice/voice-mode.ts — 语音模式循环编排器(免提对话:说→ASR→模型→TTS 播报→重开麦)
//
// 参考 Android 2.5.0 VoiceSessionController 的 runSession 状态机,落到 PC 既有件上:
//   - ASR:复用 /api/asr/realtime(server-VAD 三家),新增 {type:"turn_end"} 判停信号
//   - 回复:经消息发送队列的回复通道 POST /api/conversations/:id/voice/send(与键盘消息同队列)
//   - TTS:复用 ttsController(分片合成+播放),播报时关麦防回授,念完留 300ms 再开麦
//   - 非全双工(对齐 APP):说话时不播,播时不听;无 barge-in。
//
// 模块级单例(与 ttsController 同模式):循环脱离组件树存活,切路由/卸载不中断。

import api, { appendWebAuthQuery } from "~/services/api";
import { ttsController } from "~/lib/tts/tts-controller";
import { prepareSpeechText } from "~/lib/tts/text-filter";
import { useAppStore } from "~/stores/app-store";
import { startMicCapture, type MicCaptureHandle } from "./mic-capture";

export type VoicePhase = "off" | "connecting" | "listening" | "transcribing" | "speaking" | "error";

export interface VoiceModeState {
  phase: VoicePhase;
  /** 当前句实时转写(listening/transcribing 时展示)。 */
  transcript: string;
  error: string | null;
}

const initialVoiceState: VoiceModeState = { phase: "off", transcript: "", error: null };

/** 说→回复收尾的等待上限(慢模型兜底,防永远挂 speaking 前)。 */
const REPLY_TIMEOUT_MS = 180_000;
/** TTS 念完→重开麦的扬声器尾音衰减间隙(对齐 APP 300ms)。 */
const MIC_REOPEN_DELAY_MS = 300;

interface VoiceSession {
  conversationId: string;
  providerId: string;
  sampleRate: number;
  socket: WebSocket | null;
  mic: MicCaptureHandle | null;
}

class VoiceModeController {
  private state: VoiceModeState = { ...initialVoiceState };
  private subscribers = new Set<(s: VoiceModeState) => void>();
  private session: VoiceSession | null = null;
  private running = false;
  private stopped = false;

  getState(): VoiceModeState {
    return this.state;
  }

  subscribe(listener: (s: VoiceModeState) => void): () => void {
    this.subscribers.add(listener);
    listener(this.state);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  isActive(): boolean {
    const p = this.state.phase;
    return p !== "off" && p !== "error";
  }

  /** 进入指定会话的语音模式。重复调用 = 重启(先停旧的)。 */
  start(conversationId: string, providerId: string, sampleRate: number): void {
    this.stopInternal();
    this.stopped = false;
    this.running = true;
    this.setState({ phase: "connecting", transcript: "", error: null });
    void this.run(conversationId, providerId, sampleRate);
  }

  /** 结束语音模式(关麦、断 ASR、停 TTS、清状态)。幂等。 */
  stop(): void {
    this.stopInternal();
    this.setState({ ...initialVoiceState });
  }

  private stopInternal(): void {
    this.stopped = true;
    this.running = false;
    // 清掉挂起的转写截流定时器,防 stop 后还有一帧迟到的 setState。
    if (this.transcriptThrottleTimer) {
      clearTimeout(this.transcriptThrottleTimer);
      this.transcriptThrottleTimer = null;
    }
    const s = this.session;
    this.session = null;
    if (s) {
      try {
        s.socket?.send(JSON.stringify({ type: "stop" }));
        s.socket?.close(1000, "voice-stop");
      } catch {
        /* 已断开,忽略 */
      }
      s.mic?.stop();
    }
    ttsController.stop();
  }

  private setState(patch: Partial<VoiceModeState>): void {
    this.state = { ...this.state, ...patch };
    for (const sub of Array.from(this.subscribers)) {
      try {
        sub(this.state);
      } catch {
        /* 订阅者异常不影响循环 */
      }
    }
  }

  /** 转写预览截流:ASR partial 每个 delta 都推,说话快时每秒十几次 setState 会让横幅高频重渲染。
   *  性能加固:transcript 的【展示】按 100ms 截流(尾沿保证最后一句落地);phases/turn_end 等
   *  逻辑字段仍即时更新,不受截流影响。仅影响视觉,不影响发送时机。 */
  private transcriptThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTranscriptPaintAt = 0;

  private setTranscript(transcript: string): void {
    const now = Date.now();
    const elapsed = now - this.lastTranscriptPaintAt;
    if (this.transcriptThrottleTimer) {
      clearTimeout(this.transcriptThrottleTimer);
      this.transcriptThrottleTimer = null;
    }
    if (elapsed >= 100) {
      this.lastTranscriptPaintAt = now;
      this.setState({ transcript });
    } else {
      this.transcriptThrottleTimer = setTimeout(() => {
        this.transcriptThrottleTimer = null;
        this.lastTranscriptPaintAt = Date.now();
        this.setState({ transcript });
      }, 100 - elapsed);
    }
  }

  /** 主循环:听完一句→发送→播报→重开麦,直到 stop。任何一步出错进 error 态。 */
  private async run(conversationId: string, providerId: string, sampleRate: number): Promise<void> {
    try {
      while (this.running && !this.stopped) {
        const text = await this.listenOnce(conversationId, providerId, sampleRate);
        if (this.stopped || !this.running) return;
        if (!text) continue; // 空句(没说话就停了)直接重听
        this.setState({ phase: "transcribing" });
        const reply = await this.sendAndAwaitReply(conversationId, text);
        if (this.stopped || !this.running) return;
        if (reply) await this.speak(reply);
        if (this.stopped || !this.running) return;
        // 尾音衰减间隙(仅播报过才需要),然后下一轮 listenOnce 重新开麦。
        if (reply) await delay(MIC_REOPEN_DELAY_MS);
      }
    } catch (err) {
      if (this.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ phase: "error", error: message });
    }
  }

  /** 听一句话:开麦连 ASR,等服务端 VAD turn_end 返回该句定稿文本。resolve null = 被停/出错。 */
  private listenOnce(conversationId: string, providerId: string, sampleRate: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (text: string | null) => {
        if (settled) return;
        settled = true;
        this.teardownCapture();
        resolve(text);
      };

      const socket = new WebSocket(appendWebAuthQuery("/api/asr/realtime").replace(/^http/i, "ws"));
      socket.binaryType = "arraybuffer";
      const session: VoiceSession = {
        conversationId,
        providerId,
        sampleRate,
        socket,
        mic: null,
      };
      this.session = session;

      socket.onopen = async () => {
        socket.send(JSON.stringify({ type: "start", providerId }));
        try {
          const mic = await startMicCapture(sampleRate, (frame) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(frame);
          });
          if (this.session === session) session.mic = mic;
          else mic.stop();
        } catch (err) {
          finish(null);
          if (!this.stopped) {
            const message = err instanceof Error ? err.message : "mic";
            this.setState({ phase: "error", error: message });
          }
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let payload: { type?: string; transcript?: string; error?: string; status?: string };
        try {
          payload = JSON.parse(event.data);
        } catch {
          return; // 非 JSON 帧忽略(与后端纪律一致)
        }
        if (payload.type === "status" && payload.status === "listening") {
          this.setState({ phase: "listening", transcript: "" });
        } else if (payload.type === "transcript") {
          // 阶段即时更新,transcript 文本走截流(高频 delta 防抖)。
          this.setState({ phase: "listening" });
          this.setTranscript(payload.transcript ?? "");
        } else if (payload.type === "turn_end") {
          const text = (payload.transcript ?? "").trim();
          finish(text.length > 0 ? text : null);
        } else if (payload.type === "error") {
          const message = payload.error || "asr";
          finish(null);
          if (!this.stopped) this.setState({ phase: "error", error: message });
        }
      };
      socket.onerror = () => {
        finish(null);
        if (!this.stopped) this.setState({ phase: "error", error: "asr-connect" });
      };
      socket.onclose = () => {
        // 非主动 stop 的意外断开:若在听,按出错收尾本句。
        if (!settled && !this.stopped) finish(null);
      };
    });
  }

  private teardownCapture(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    try {
      s.socket?.send(JSON.stringify({ type: "stop" }));
      s.socket?.close(1000, "turn-done");
    } catch {
      /* 已断开 */
    }
    s.mic?.stop();
  }

  /** 发送并等模型回复(走队列回复通道);超时/失败/被停 → null。 */
  private async sendAndAwaitReply(conversationId: string, text: string): Promise<string | null> {
    try {
      const result = await api.post<{ reply?: string | null }>(
        `conversations/${conversationId}/voice/send`,
        { parts: [{ type: "text", text }] },
        { timeout: false },
      );
      return typeof result?.reply === "string" && result.reply.trim().length > 0 ? result.reply : null;
    } catch {
      return null; // 发送失败不算致命,重开麦继续(APP 静默语义)
    }
  }

  /** 播报回复并等播完(订阅 ttsController 的 Ended/Idle)。播报期间麦克风已关。 */
  private speak(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setState({ phase: "speaking" });
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        unsub();
        resolve();
      };
      const timeout = setTimeout(done, REPLY_TIMEOUT_MS); // 兜底,防状态卡死
      const unsub = ttsController.subscribe((s) => {
        if (s.status === "Ended" || s.status === "Idle" || s.status === "Error") {
          clearTimeout(timeout);
          done();
        }
      });
      // 朗读过滤(台账 §4.1):与消息朗读同一条链,reply 是后端直回的纯文本,客户端补过滤。
      const display = useAppStore.getState().settings?.displaySetting;
      const filtered = prepareSpeechText(text, {
        onlyReadQuoted: display?.ttsOnlyReadQuoted === true,
        readOutsideBrackets: display?.ttsOnlyReadOutsideBrackets === true,
      });
      if (!filtered) {
        done();
        return;
      }
      ttsController.speak(filtered, "voice-mode", true);
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const voiceMode = new VoiceModeController();

import * as React from "react";

export function useVoiceModeState(): VoiceModeState {
  const [state, setState] = React.useState<VoiceModeState>(() => voiceMode.getState());
  React.useEffect(() => voiceMode.subscribe(setState), []);
  return state;
}
