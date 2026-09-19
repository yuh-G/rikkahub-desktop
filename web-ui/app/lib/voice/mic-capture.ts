// lib/voice/mic-capture.ts — 麦克风采集 + PCM16 编码(语音听写与语音模式共用单一实现)
//
// 职责:getUserMedia → AudioContext → (ScriptProcessor)采样 → 重采样到目标采样率 → PCM16 →
// 按固定帧大小切片 → onFrame(ArrayBuffer)。不含网络(调用方把帧送进自己的 WebSocket)。
//
// 抽取自 chat-input 的内联 ASR 采集逻辑,两处共用避免重复实现漂移。

const FRAME_SIZE = 4096;

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

export interface MicCaptureHandle {
  /** 停止采集并释放全部资源(关 AudioContext、停麦克风轨)。幂等。 */
  stop: () => void;
}

/**
 * 启动麦克风采集。targetSampleRate 依 provider(openai_realtime 24k / 其他 16k)。
 * onFrame 回调每个 PCM16 帧(ArrayBuffer);返回清理句柄。
 * 抛错 = 拿不到麦克风(权限被拒/无设备),由调用方提示。
 */
export async function startMicCapture(
  targetSampleRate: number,
  onFrame: (frame: ArrayBuffer) => void,
): Promise<MicCaptureHandle> {
  // 能力探测(P2,issue #55/#56 同源):getUserMedia 只在安全上下文(HTTPS/localhost)可用。
  // Docker 裸 IP(http://<host>:8080)等非安全上下文下 navigator.mediaDevices 是 undefined,
  // 裸调会抛浏览器黑话 TypeError。这里先探测、抛带码错误,让调用方给出人话提示而非崩。
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") {
    throw new Error("mic_insecure_context");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);

  let pending: Int16Array[] = [];
  let pendingSamples = 0;
  let stopped = false;

  const rate = Math.max(8000, targetSampleRate);
  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const channel = event.inputBuffer.getChannelData(0);
    const pcmBuffer = floatToPcm16(resampleLinear(channel, audioContext.sampleRate, rate));
    const chunk = new Int16Array(pcmBuffer);
    pending.push(chunk);
    pendingSamples += chunk.length;
    while (pendingSamples >= FRAME_SIZE) {
      const frame = new Int16Array(FRAME_SIZE);
      let offset = 0;
      while (offset < FRAME_SIZE) {
        const head = pending[0];
        const take = Math.min(head.length, FRAME_SIZE - offset);
        frame.set(head.subarray(0, take), offset);
        offset += take;
        if (take === head.length) {
          pending.shift();
        } else {
          pending[0] = head.subarray(take);
        }
        pendingSamples -= take;
      }
      onFrame(frame.buffer);
    }
  };
  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      void audioContext.close().catch(() => undefined);
      stream.getTracks().forEach((track) => track.stop());
      pending = [];
      pendingSamples = 0;
    },
  };
}
