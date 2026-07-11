/**
 * Прекеш голосовых ФИЛЛЕРОВ (§10 realtime) — маскировка латентности LLM.
 *
 * Opus отдаёт первый токен за ~2с (требование пользователя — модель не менять). Чтобы голос
 * ОЩУЩАЛСЯ realtime, на конце фразы пользователя мы СРАЗУ проигрываем короткое дворецкое
 * «Секунду, сэр.» — заранее синтезированное тем же голосом ElevenLabs (multilingual_v2) и
 * лежащее в памяти. Первый звук идёт через ~250мс, а реальный ответ Opus подъезжает следом
 * (клиентская очередь воспроизведения играет их подряд). Это НЕ ускоряет Opus — это прячет
 * его пол за естественной паузой-подтверждением (так делают LiveKit/Pipecat/Vapi).
 *
 * Прекеш one-time на старте gateway (несколько фраз), ротация по кругу — не приедается.
 * Лучшее-усилие: нет ключа/синтез упал → филлеров нет, голос работает как прежде (без них).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { ITtsProvider, TtsOpts } from "../integrations/voice-providers.js";

const log: Logger = createLogger("voice:filler");

/** Короткие дворецкие подтверждения-мостики (ротация — чтобы не приедалось). */
export const DEFAULT_FILLERS = ["Секунду, сэр.", "Одну минуту.", "Сейчас, сэр.", "Минуту."];

/** Обернуть сырой PCM16 (mono LE) в WAV-контейнер (RIFF) — чтобы клиентский плеер сыграл его как
 *  самодостаточный буфер (он сниффит RIFF). Зеркало renderer/audio.wavFromPcm16, серверная сторона. */
function wavFromPcm16(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const out = new Uint8Array(44 + pcm.byteLength);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out.buffer;
}

/** Собрать полный синтез фразы в один буфер (TtsStream → bytes). null при ошибке/пустом.
 *  §Волна3 ревью (#20): под TTS_PROVIDER=yandex3 чанки — сырой PCM16 (format="pcm16"); тогда оборачиваем
 *  собранный буфер в WAV, иначе playFiller слал бы его БЕЗ format → клиент декодировал бы как mp3 →
 *  тишина (филлер молча не играет). Контейнерное аудио (mp3/v1) отдаём как есть. */
export function synthesizeToBuffer(
  tts: ITtsProvider,
  text: string,
  opts?: TtsOpts,
): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const parts: Uint8Array[] = [];
    let isPcm = false;
    let pcmRate = 22_050;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (!ok || parts.length === 0) return resolve(null);
      const total = parts.reduce((n, p) => n + p.byteLength, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        merged.set(p, off);
        off += p.byteLength;
      }
      resolve(isPcm ? wavFromPcm16(merged, pcmRate) : merged.buffer);
    };
    try {
      const stream = tts.synthesize(text, opts);
      stream.onChunk((c) => {
        if (c.format === "pcm16") {
          isPcm = true;
          if (c.sampleRate) pcmRate = c.sampleRate;
        }
        if (c.audio.byteLength) parts.push(new Uint8Array(c.audio));
      });
      stream.onError(() => finish(false));
      stream.onDone(() => finish(true));
    } catch {
      finish(false);
    }
  });
}

export class FillerCache {
  private buffers: ArrayBuffer[] = [];
  private idx = 0;

  /** Готов ли хоть один филлер (иначе pick() → null, филлер просто не играется). */
  get ready(): boolean {
    return this.buffers.length > 0;
  }

  get size(): number {
    return this.buffers.length;
  }

  /**
   * Синтезировать набор филлеров заранее (one-time на старте). voiceId/opts — дефолтный
   * голос дворецкого (режим-маска §11 на филлеры не распространяем — они короткие и общие).
   * Лучшее-усилие: что синтезировалось — то и кешируем; ничего — pick() вернёт null.
   */
  async warmup(tts: ITtsProvider, opts?: TtsOpts, phrases: string[] = DEFAULT_FILLERS): Promise<number> {
    if (!tts.live) {
      log.info("TTS не live — филлеры не прекешируем (mock-режим)");
      return 0;
    }
    const results = await Promise.all(phrases.map((p) => synthesizeToBuffer(tts, p, opts)));
    this.buffers = results.filter((b): b is ArrayBuffer => b !== null && b.byteLength > 0);
    log.info("филлеры прекешированы", { ok: this.buffers.length, total: phrases.length });
    return this.buffers.length;
  }

  /** Следующий филлер по кругу (ротация), либо null если не прекешировано. */
  pick(): ArrayBuffer | null {
    if (this.buffers.length === 0) return null;
    const b = this.buffers[this.idx % this.buffers.length] ?? null;
    this.idx += 1;
    return b;
  }
}
