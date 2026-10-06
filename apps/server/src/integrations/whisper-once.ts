/** Разовый локальный STT использует тот же распознаватель и фильтр тишины, что голосовой поток. */
import type { ISttProvider } from "./voice-providers.js";

export const WHISPER_ONCE_TIMEOUT_MS = 4_000;

export function transcribeUtterance(provider: Pick<ISttProvider, "open">, pcm: ArrayBuffer, sampleRate: number, signal?: AbortSignal): Promise<string> {
  if (sampleRate !== 16_000) return Promise.reject(new Error("Whisper expects PCM16 mono at 16000 Hz"));
  if (pcm.byteLength % 2 || pcm.byteLength > 16_000 * 2 * 30) return Promise.reject(new Error("Invalid Whisper utterance length"));
  if (signal?.aborted) return Promise.reject(new Error("Whisper transcription aborted"));
  return new Promise((resolve, reject) => {
    let text = "";
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("Whisper transcription aborted")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Whisper transcription timed out")); }, WHISPER_ONCE_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const stream = provider.open({ sampleRate, language: "ru" });
      stream.onPartial((p) => { if (p.final) text = p.text; });
      stream.onError((e) => { cleanup(); reject(e); });
      stream.onClose(() => { cleanup(); resolve(text); });
      stream.pushAudio(pcm);
      void stream.close().catch((e: unknown) => { cleanup(); reject(e); });
    } catch (e) { cleanup(); reject(e); }
  });
}
