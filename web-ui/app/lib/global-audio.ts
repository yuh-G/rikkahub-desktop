/**
 * Global TTS playback singleton — mirrors Android's `LocalTTSState` (a single
 * `TtsController` shared across the whole app). The PC client previously gave every
 * `ChatMessageActionsRow` its own `audioRef`, so clicking "speak" on message B while
 * message A was playing started a second `Audio` element and both played in parallel.
 *
 * The fix is to lift playback state out of React entirely. Every speak request goes
 * through `playAudio` / `playSpeechSynthesis`, which stops whatever is currently
 * playing (audio element, synthesis utterance, system TTS hint) before starting the
 * new playback. Components subscribe via the React hook `useAudioPlaybackKey()` to
 * know whether their own message is the currently-playing one and render their button
 * (play vs stop) accordingly.
 *
 * Why a module-level singleton instead of a React Context: the chat message list is
 * virtualized and `ChatMessageActionsRow` instances can unmount mid-playback (the
 * scrolled-out-of-view case). With a Context provider sitting somewhere above the
 * list we'd survive that, but a plain module singleton survives it just as well with
 * less plumbing, and matches the way Android's `TtsController` lives at app scope.
 */

type AudioBackend =
  | { kind: "audio"; element: HTMLAudioElement; objectUrl: string | null }
  | { kind: "synthesis" }
  | { kind: "system-hint" };

let currentKey: string | null = null;
let currentBackend: AudioBackend | null = null;
const listeners = new Set<(key: string | null) => void>();

function notify() {
  // Iterate over a copy to allow listeners to unsubscribe mid-iteration.
  for (const listener of Array.from(listeners)) listener(currentKey);
}

/**
 * Stops whatever is currently playing. Safe to call even when nothing is playing —
 * the function is idempotent. Always called before starting a new playback to
 * enforce the "one stream at a time" invariant.
 */
export function stopAudio() {
  if (currentBackend) {
    try {
      if (currentBackend.kind === "audio") {
        currentBackend.element.pause();
        // Clearing src + load() releases the underlying media resource immediately;
        // some browsers otherwise keep decoding the trailing buffer for a beat.
        currentBackend.element.src = "";
        currentBackend.element.load();
        if (currentBackend.objectUrl) {
          URL.revokeObjectURL(currentBackend.objectUrl);
        }
      } else if (currentBackend.kind === "synthesis") {
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
      }
      // system-hint TTS produces audio server-side; we clear the speaking flag.
    } catch {
      // Best-effort cleanup — never throw from stopAudio.
    }
  }
  currentBackend = null;
  if (currentKey !== null) {
    currentKey = null;
    notify();
  }
}

/**
 * Play an HTMLAudioElement-backed source (typically a blob URL returned from the
 * server). Stops whatever is currently playing first.
 *
 * @param key Unique identifier for whoever owns this playback (e.g. a message id).
 *            Subsequent `useAudioPlaybackKey()` reads will return this string until
 *            playback ends/stops; used to drive the play/stop button icon.
 * @param objectUrl A blob: URL — will be `URL.revokeObjectURL`'d when playback ends.
 *                  Pass `null` if you don't own the URL lifetime.
 */
export async function playAudio(key: string, src: string, objectUrl: string | null = null): Promise<void> {
  stopAudio();
  const audio = new Audio(src);
  const backend: AudioBackend = { kind: "audio", element: audio, objectUrl };
  currentBackend = backend;
  currentKey = key;
  notify();

  audio.addEventListener("ended", () => {
    // Only clear if this is still the current playback; a rapid play→play could
    // have already swapped us out, in which case the new playback owns the state.
    if (currentBackend === backend) stopAudio();
  });
  audio.addEventListener("error", () => {
    if (currentBackend === backend) stopAudio();
  });

  try {
    await audio.play();
  } catch (err) {
    // Autoplay rejection / decode error — drop state.
    if (currentBackend === backend) stopAudio();
    throw err;
  }
}

/**
 * Play via the browser's built-in SpeechSynthesis API. Used as a graceful fallback
 * when the configured TTS provider is unreachable.
 */
export function playSpeechSynthesis(key: string, text: string): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  stopAudio();
  const utterance = new SpeechSynthesisUtterance(text);
  const backend: AudioBackend = { kind: "synthesis" };
  currentBackend = backend;
  currentKey = key;
  notify();
  utterance.onend = () => {
    if (currentBackend === backend) stopAudio();
  };
  utterance.onerror = () => {
    if (currentBackend === backend) stopAudio();
  };
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  return true;
}

/**
 * Mark "system TTS speaking" so the button can show the stop icon. The actual
 * audio is produced server-side; we don't know when it ends, so we auto-clear
 * after the provided estimated duration. The user can also click stop manually
 * but that won't stop the on-device playback — a limitation of the system TTS wrapper.
 */
export function markSystemTtsSpeaking(key: string, estimatedDurationMs: number): void {
  stopAudio();
  currentBackend = { kind: "system-hint" };
  currentKey = key;
  notify();
  const backend = currentBackend;
  window.setTimeout(() => {
    if (currentBackend === backend) stopAudio();
  }, estimatedDurationMs);
}

/** Returns the current playback key, or `null` if nothing is playing. */
export function getAudioPlaybackKey(): string | null {
  return currentKey;
}

import * as React from "react";

/**
 * React hook returning the current playback key. Components compare this against
 * their own key (typically a message id) to decide whether to render play or stop.
 */
export function useAudioPlaybackKey(): string | null {
  const [key, setKey] = React.useState<string | null>(() => currentKey);
  React.useEffect(() => {
    const listener = (next: string | null) => setKey(next);
    listeners.add(listener);
    // Sync in case the key changed between render and subscribe.
    setKey(currentKey);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return key;
}
