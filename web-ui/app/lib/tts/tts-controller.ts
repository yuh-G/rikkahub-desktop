/**
 * PC port of speech/src/main/java/me/rerere/tts/controller/TtsController.kt.
 *
 * Exact 1:1 replication of Android's architecture:
 *   - TextChunker splits text (≤160 chars per chunk, split on punctuation/newlines)
 *   - Worker loop: pull chunk from queue → await synthesis → play audio → advance
 *   - Prefetch window of 2 chunks ahead (cache: chunkId → Promise<Blob>)
 *   - Pause: set isPaused flag + audio.pause(); worker spins in delay(80) loop
 *   - Resume: clear isPaused + audio.play(); worker exits spin naturally
 *   - Stop: cancel everything, kill all audio, clear cache
 *   - Speed: audio.playbackRate (applies immediately to current + future chunks)
 *   - SeekBy: audio.currentTime += ms/1000 (within current chunk only)
 *   - PlaybackState mirrors Android's exactly: positionMs/durationMs/speed/currentChunkIndex/totalChunks
 *
 * 稳定性/自动重试(§4.3):分片合成在服务端 synthesize 层按 HTTP 语义重试(408/429/5xx/网络
 * 瞬断退避,400/401 立即失败),客户端这里只取最终结果。配合两件事对齐 Android:
 *   - 预取窗口 2(同 Android prefetchCount=2):用户只听前几句就停时不白烧后段 API 额度。
 *   - 失败分片从缓存剔除:带 reject 的 Promise 不可复用,否则同一分片永远拿同一个失败。
 *
 * All providers (system + online) now return audio bytes from the server. System TTS uses
 * SetOutputToWaveFile on the server side (mirrors Android's synthesizeToFile), so the
 * client treats all providers identically — no special-casing needed.
 */

import type { PlaybackState } from "./playback-state";
import { initialPlaybackState } from "./playback-state";
import { TextChunker, type TtsChunk } from "./text-chunker";
import { appendWebAuthQuery } from "~/services/api";

const PREFETCH_COUNT = 2;
const CHUNK_DELAY_MS = 120;
const POSITION_POLL_MS = 100;

type Subscriber = (state: PlaybackState) => void;

interface PendingSynthesis {
  promise: Promise<Blob>;
  abort: AbortController;
}

class TtsControllerImpl {
  private readonly chunker = new TextChunker(160);

  private audio: HTMLAudioElement | null = null;
  private aliveAudios = new Set<HTMLAudioElement>();
  private activePlayReject: ((err: Error) => void) | null = null;

  private isPaused = false;
  private queue: TtsChunk[] = [];
  private allChunks: TtsChunk[] = [];
  private cache = new Map<string, PendingSynthesis>();
  private lastPrefetchedIndex = -1;
  private currentSessionId: string | null = null;
  private workerRunning = false;

  /** 100ms position polling interval (mirrors Android's startPositionUpdates). */
  private positionInterval: ReturnType<typeof setInterval> | null = null;

  private subscribers = new Set<Subscriber>();
  private state: PlaybackState = { ...initialPlaybackState };

  // ── public API ───────────────────────────────────────────────────────────

  getState(): PlaybackState {
    return this.state;
  }

  subscribe(listener: Subscriber): () => void {
    this.subscribers.add(listener);
    listener(this.state);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  speak(text: string, ownerKey: string | null = null, flush = true) {
    if (!text.trim()) return;
    const newChunks = this.chunker.split(text);
    if (newChunks.length === 0) return;

    if (flush) {
      this.internalReset();
      const sessionId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.currentSessionId = sessionId;
      this.allChunks = [...newChunks];
      this.queue = [...newChunks];
      this.updateState({
        status: "Buffering",
        currentChunkIndex: 0,
        totalChunks: newChunks.length,
        positionMs: 0,
        durationMs: 0,
        errorMessage: null,
        sessionId,
        ownerKey,
      });
    } else {
      const startIndex = (this.allChunks[this.allChunks.length - 1]?.index ?? -1) + 1;
      const remapped = newChunks.map((c, i) => ({ ...c, index: startIndex + i }));
      this.allChunks.push(...remapped);
      this.queue.push(...remapped);
      this.updateState({ totalChunks: this.allChunks.length });
    }

    this.prefetchFrom(0);
    if (!this.workerRunning) void this.runWorker();
  }

  pause() {
    if (this.state.status !== "Playing" && this.state.status !== "Buffering") return;
    this.isPaused = true;
    if (this.audio)
      try {
        this.audio.pause();
      } catch {
        /* */
      }
    this.stopPositionUpdates();
    this.updateState({ status: "Paused" });
  }

  resume() {
    if (this.state.status !== "Paused") return;
    this.isPaused = false;
    if (this.audio && this.audio.readyState >= 2) {
      this.audio.play().catch(() => {
        /* */
      });
      this.startPositionUpdates();
      this.updateState({ status: "Playing" });
    } else {
      this.updateState({ status: "Buffering" });
    }
  }

  stop() {
    void fetch(appendWebAuthQuery("/api/tts/cancel"), { method: "POST" }).catch(() => {});
    this.internalReset();
  }

  seekBy(ms: number) {
    if (!this.audio) return;
    this.audio.currentTime = Math.max(0, this.audio.currentTime + ms / 1000);
  }

  setSpeed(speed: number) {
    const clamped = Math.max(0.25, Math.min(4.0, speed));
    if (this.audio) this.audio.playbackRate = clamped;
    this.updateState({ speed: clamped });
  }

  // ── worker loop (mirrors Android's startWorker coroutine) ────────────────

  private async runWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    const sessionId = this.currentSessionId!;
    let processedCount = 0;

    try {
      while (true) {
        if (sessionId !== this.currentSessionId) break;

        if (this.isPaused) {
          await delay(80);
          continue;
        }

        const chunk = this.queue.shift();
        if (!chunk) break;

        processedCount += 1;
        this.updateState({
          currentChunkIndex: processedCount,
          status: "Buffering",
          positionMs: 0,
          durationMs: 0,
        });

        this.prefetchFrom(chunk.index + 1);

        // Await synthesis
        let blob: Blob;
        try {
          blob = await this.awaitOrCreate(chunk);
        } catch (err) {
          if (sessionId !== this.currentSessionId) break;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "TTS reset") break;
          this.updateState({ status: "Error", errorMessage: msg });
          continue;
        }

        if (sessionId !== this.currentSessionId) break;
        if (blob.size === 0) continue;

        // Play audio (suspends until ended, like Android's audio.play(response))
        try {
          await this.playBlob(blob, sessionId);
        } catch (err) {
          if (sessionId !== this.currentSessionId) break;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "TTS reset") break;
          this.updateState({ status: "Error", errorMessage: msg });
        }

        if (sessionId !== this.currentSessionId) break;
        if (this.queue.length > 0) await delay(CHUNK_DELAY_MS);
      }
    } finally {
      this.workerRunning = false;
      if (sessionId === this.currentSessionId && this.queue.length === 0) {
        this.updateState({ status: "Ended" });
        setTimeout(() => {
          if (this.state.status === "Ended" && sessionId === this.currentSessionId) {
            this.internalReset();
          }
        }, 800);
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private internalReset() {
    this.currentSessionId = null;

    if (this.activePlayReject) {
      const rej = this.activePlayReject;
      this.activePlayReject = null;
      try {
        rej(new Error("TTS reset"));
      } catch {
        /* */
      }
    }

    for (const audio of Array.from(this.aliveAudios)) {
      try {
        audio.pause();
        audio.src = "";
      } catch {
        /* */
      }
    }
    this.aliveAudios.clear();
    this.audio = null;

    this.stopPositionUpdates();
    this.isPaused = false;
    this.queue = [];
    this.allChunks = [];
    for (const pending of this.cache.values()) {
      try {
        pending.abort.abort();
      } catch {
        /* */
      }
    }
    this.cache.clear();
    this.lastPrefetchedIndex = -1;
    this.state = { ...initialPlaybackState };
    this.notify();
  }

  private prefetchFrom(startIndex: number) {
    const begin = Math.max(startIndex, this.lastPrefetchedIndex + 1);
    const endExclusive = Math.min(begin + PREFETCH_COUNT, this.allChunks.length);
    if (begin >= endExclusive) return;
    for (let i = begin; i < endExclusive; i += 1) {
      const chunk = this.allChunks[i];
      if (!chunk || this.cache.has(chunk.id)) continue;
      this.cache.set(chunk.id, this.synthesizeChunk(chunk));
    }
    this.lastPrefetchedIndex = endExclusive - 1;
  }

  private synthesizeChunk(chunk: TtsChunk): PendingSynthesis {
    const abort = new AbortController();
    const speed = this.state.speed;
    const promise = (async () => {
      const response = await fetch(appendWebAuthQuery("/api/tts/speech"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk.text, speed }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`TTS: ${response.status} ${text.slice(0, 200)}`);
      }
      return await response.blob();
    })();
    return { promise, abort };
  }

  private async awaitOrCreate(chunk: TtsChunk): Promise<Blob> {
    let pending = this.cache.get(chunk.id);
    if (!pending) {
      pending = this.synthesizeChunk(chunk);
      this.cache.set(chunk.id, pending);
    }
    try {
      return await pending.promise;
    } catch (err) {
      // 失败分片从缓存剔除(§4.3):带 reject 的 Promise 不可复用,留着会让同一分片永远拿同一个
      // 失败。剔除后若该分片再次被请求会重新合成。(对齐 Android awaitOrCreate 的 cache.remove。)
      if (this.cache.get(chunk.id) === pending) this.cache.delete(chunk.id);
      throw err;
    }
  }

  private playBlob(blob: Blob, sessionId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = this.state.speed;
      this.audio = audio;
      this.aliveAudios.add(audio);

      const cleanup = () => {
        this.stopPositionUpdates();
        URL.revokeObjectURL(url);
        this.aliveAudios.delete(audio);
        if (this.audio === audio) this.audio = null;
        this.activePlayReject = null;
      };

      this.activePlayReject = (err) => {
        try {
          audio.pause();
          audio.src = "";
        } catch {
          /* */
        }
        cleanup();
        reject(err);
      };

      audio.onloadedmetadata = () => {
        if (this.audio !== audio) return;
        const dur = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
        this.updateState({ durationMs: dur, positionMs: 0 });
      };

      audio.onended = () => {
        cleanup();
        resolve();
      };

      audio.onerror = () => {
        cleanup();
        reject(new Error("Audio playback error"));
      };

      this.updateState({ status: "Playing" });
      this.startPositionUpdates();
      audio.play().catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  private startPositionUpdates() {
    this.stopPositionUpdates();
    this.positionInterval = setInterval(() => {
      if (!this.audio) return;
      const pos = this.audio.currentTime * 1000;
      const dur = Number.isFinite(this.audio.duration)
        ? this.audio.duration * 1000
        : this.state.durationMs;
      this.updateState({ positionMs: pos, durationMs: dur });
    }, POSITION_POLL_MS);
  }

  private stopPositionUpdates() {
    if (this.positionInterval != null) {
      clearInterval(this.positionInterval);
      this.positionInterval = null;
    }
  }

  private updateState(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private notify() {
    for (const sub of Array.from(this.subscribers)) {
      try {
        sub(this.state);
      } catch {
        /* */
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ttsController = new TtsControllerImpl();

import * as React from "react";

export function useTtsPlaybackState(): PlaybackState {
  const [state, setState] = React.useState<PlaybackState>(() => ttsController.getState());
  React.useEffect(() => ttsController.subscribe(setState), []);
  return state;
}

export function useIsTtsActiveForKey(key: string | null): boolean {
  const state = useTtsPlaybackState();
  if (!key) return false;
  return state.ownerKey === key && state.status !== "Idle" && state.status !== "Ended";
}
