/**
 * §Волна3 (3.5) — TTS Yandex SpeechKit v3 (REST utteranceSynthesis, server-streaming): первые байты
 * звука приходят за ~150-300мс и СРАЗУ уходят клиенту чанками (formаt=pcm16) — минус 300-600мс
 * до первого звука на КАЖДОЙ фразе против v1 («полный mp3 одним ответом»).
 *
 * ОПТ-ИН: TTS_PROVIDER=yandex3 (боевой дефолт остаётся v1/yandex — свап только осознанно).
 * Транспорт — REST-стрим (grpc-gateway): POST /tts/v3/utteranceSynthesis → поток JSON-строк
 * {"result":{"audioChunk":{"data":"<base64>"}}}. gRPC-зависимости не нужны.
 * Аудио — сырой LINEAR16_PCM 22050Гц: клиент играет чанки через WebAudio ПО МЕРЕ ПРИХОДА
 * (см. renderer/audio.ts), а занятый плеер честно собирает их в WAV и играет как обычную озвучку.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import {
  type ITtsProvider,
  MockTtsStream,
  type TtsChunk,
  type TtsOpts,
  type TtsStream,
  adaptiveSpeed,
  stripAudioTags,
} from "./voice-providers.js";
import { type Emotion, yandexEmotionParam } from "./tts-emotion.js";
import { type YandexTtsConfig, tameYandexPunctuation } from "./yandex-tts.js";

const log: Logger = createLogger("tts:yandex3");

const SYNTH_URL_V3 = "https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis";
const DEFAULT_VOICE = process.env.YANDEX_VOICE || "filipp";
/** Частота сырого PCM (v3 rawAudio). 22050 — баланс качества/трафика для голоса. */
export const V3_SAMPLE_RATE = 22_050;
/** Нет ни одного чанка дольше этого — считаем стрим зависшим (abort). */
const INACTIVITY_MS = 8_000;

/** Стрим v3: чанки уходят слушателю ПО МЕРЕ ПРИХОДА (не ждём весь синтез). */
class YandexV3Stream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private errorCb?: (e: Error) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  private done = false;
  private seq = 0;
  private readonly controller = new AbortController();
  private inactivity?: ReturnType<typeof setTimeout>;

  constructor(
    text: string,
    apiKey: string,
    folderId: string | undefined,
    voice: string,
    speed: number,
    emotionRole: string | undefined,
  ) {
    void this.run(text, apiKey, folderId, voice, speed, emotionRole);
  }

  private bumpInactivity(): void {
    if (this.inactivity) clearTimeout(this.inactivity);
    this.inactivity = setTimeout(() => {
      if (!this.done && !this._cancelled) {
        log.warn("v3-стрим замолчал — abort");
        try {
          this.controller.abort();
        } catch {
          /* уже завершён */
        }
      }
    }, INACTIVITY_MS);
    (this.inactivity as { unref?: () => void }).unref?.();
  }

  private async run(
    text: string,
    apiKey: string,
    folderId: string | undefined,
    voice: string,
    speed: number,
    emotionRole: string | undefined,
  ): Promise<void> {
    this.bumpInactivity();
    try {
      const clean = tameYandexPunctuation(stripAudioTags(text));
      const spoken = Math.min(3, Math.max(0.1, adaptiveSpeed(clean, speed)));
      const hints: Array<Record<string, unknown>> = [{ voice }, { speed: spoken }];
      if (emotionRole) hints.push({ role: emotionRole });
      const resp = await fetch(SYNTH_URL_V3, {
        method: "POST",
        signal: this.controller.signal,
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          "Content-Type": "application/json",
          ...(folderId ? { "x-folder-id": folderId } : {}),
        },
        body: JSON.stringify({
          text: clean,
          hints,
          outputAudioSpec: { rawAudio: { audioEncoding: "LINEAR16_PCM", sampleRateHertz: String(V3_SAMPLE_RATE) } },
          loudnessNormalizationType: "LUFS",
        }),
      });
      if (!resp.ok || !resp.body) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${detail.slice(0, 160)}`);
      }
      // grpc-gateway стримит JSON-объекты построчно: {"result":{"audioChunk":{"data":"..."}}}\n
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let bytesTotal = 0;
      const t0 = Date.now();
      let firstAt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (this._cancelled) return;
        if (done) break;
        this.bumpInactivity();
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (!line) continue;
          let msg: { result?: { audioChunk?: { data?: string } }; error?: { message?: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // неполная/служебная строка
          }
          if (msg.error) throw new Error(String(msg.error.message ?? "v3 error"));
          const b64 = msg.result?.audioChunk?.data;
          if (!b64) continue;
          const audio = Buffer.from(b64, "base64");
          if (audio.byteLength === 0) continue;
          if (!firstAt) {
            firstAt = Date.now();
            log.info("v3: первый аудио-чанк", { ttfbMs: firstAt - t0, voice });
          }
          bytesTotal += audio.byteLength;
          this.chunkCb?.({
            audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer,
            seq: this.seq++,
            last: false,
            format: "pcm16",
            sampleRate: V3_SAMPLE_RATE,
          });
        }
      }
      if (this._cancelled) return;
      if (bytesTotal === 0) throw new Error("v3: стрим завершился без аудио");
      // Финальный маркер озвучки (пустой last-чанк — клиентский плеер закрывает utterance).
      this.chunkCb?.({ audio: new ArrayBuffer(0), seq: this.seq++, last: true, format: "pcm16", sampleRate: V3_SAMPLE_RATE });
      log.info("v3: синтез готов", { bytes: bytesTotal, ms: Date.now() - t0 });
      this.finish();
    } catch (e) {
      if (this._cancelled) return;
      log.warn("v3 TTS ошибка", e instanceof Error ? e.message : String(e));
      this.errorCb?.(e instanceof Error ? e : new Error(String(e)));
      this.finish();
    }
  }

  private finish(): void {
    if (this.inactivity) clearTimeout(this.inactivity);
    if (this.done || this._cancelled) return;
    this.done = true;
    this.doneCb?.();
  }

  onChunk(cb: (c: TtsChunk) => void): void {
    this.chunkCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errorCb = cb;
  }
  onDone(cb: () => void): void {
    this.doneCb = cb;
  }
  cancel(): void {
    this._cancelled = true;
    if (this.inactivity) clearTimeout(this.inactivity);
    try {
      this.controller.abort();
    } catch {
      /* уже завершён */
    }
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
}

export class YandexTtsV3Provider implements ITtsProvider {
  readonly live: boolean;
  constructor(private readonly cfg: YandexTtsConfig) {
    this.live = Boolean(cfg.apiKey);
    if (!this.live) log.warn("Yandex v3 не сконфигурирован (нет API-ключа) — TTS в mock-режиме");
  }

  synthesize(text: string, opts?: TtsOpts): TtsStream {
    if (!this.cfg.apiKey) return new MockTtsStream(text);
    const req = opts?.voiceId;
    const voice = req && /^[a-z_]{3,20}$/.test(req) ? req : (this.cfg.voiceId ?? DEFAULT_VOICE);
    const envSpeed = Number.parseFloat(process.env.YANDEX_SPEED ?? "");
    const baseSpeed = opts?.speed ?? (Number.isFinite(envSpeed) ? envSpeed : 1.0);
    const speed = Math.min(3, Math.max(0.1, baseSpeed));
    const emotionRole = yandexEmotionParam(voice, opts?.emotion as Emotion | undefined, process.env.YANDEX_EMOTION);
    return new YandexV3Stream(text, this.cfg.apiKey, this.cfg.folderId, voice, speed, emotionRole);
  }
}
