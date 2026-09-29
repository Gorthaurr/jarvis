/**
 * Сборка озвучки из speak.chunk в фразы и сохранение в файлы (mp3 как есть, pcm16 → WAV, RIFF → WAV). Склеиваем по `last`
 * (карта §4.2): Yandex v1/ElevenLabs — один mp3 на фразу, v3 — pcm16-чанки до `last`, earcon/филлер — целый WAV.
 * Плееру нужна длительность КАЖДОГО чанка сразу (pcm16 играется по мере прихода), сохранению — законченная фраза.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AudioKind, EXT, MIME, mp3DurationMs, pcm16DurationMs, sniff, wavDurationMs } from "./audio-format.js";
import { wavFromPcm16 } from "./wav.js";

export interface SpeakChunkIn {
  audio: Buffer;
  seq: number;
  last: boolean;
  format?: string;
  sampleRate?: number;
  gen?: number;
}

export interface Phrase {
  kind: AudioKind;
  mime: string;
  bytes: number;
  durationMs: number;
  /** Длительность оценена по размеру (mp3 не разобрался). */
  estimated: boolean;
  gen?: number;
  /** Путь сохранённого файла (после SpeechStore.save). */
  file?: string;
}

/** Законченная фраза вместе с содержимым файла (для сохранения). */
export interface AssembledPhrase extends Phrase {
  data: Buffer;
}

export interface Pushed {
  /** Сколько звука добавил чанк (мс) — для плеера. pcm16 — сразу; mp3/wav — вся длительность на `last`; иначе null. */
  pieceMs: number | null;
  estimated: boolean;
  phrase: AssembledPhrase | null;
}

/** Собирает чанки одного потока в фразы. */
export class SpeechAssembler {
  private parts: Buffer[] = [];
  private pcmRate = 24_000;
  private pcmMode = false;

  push(c: SpeakChunkIn): Pushed {
    if (c.format === "pcm16") {
      this.pcmMode = true;
      this.pcmRate = c.sampleRate ?? this.pcmRate;
    }
    this.parts.push(c.audio);
    const gen = c.gen !== undefined ? { gen: c.gen } : {};
    if (this.pcmMode) {
      const pieceMs = pcm16DurationMs(c.audio.length, this.pcmRate);
      if (!c.last) return { pieceMs, estimated: false, phrase: null };
      const all = this.take();
      this.pcmMode = false;
      const even = all.length - (all.length % 2);
      const pcm = new Int16Array(all.buffer.slice(all.byteOffset, all.byteOffset + even));
      const ms = pcm16DurationMs(even, this.pcmRate);
      return { pieceMs, estimated: false, phrase: { kind: "pcm16", mime: MIME.pcm16, bytes: all.length, durationMs: ms, estimated: false, ...gen, data: wavFromPcm16(pcm, this.pcmRate) } };
    }
    if (!c.last) return { pieceMs: null, estimated: false, phrase: null };
    const all = this.take();
    const kind = sniff(all);
    const d = kind === "mp3" ? mp3DurationMs(all) : { ms: kind === "wav" ? wavDurationMs(all) : 0, estimated: kind === "bin" };
    return { pieceMs: d.ms, estimated: d.estimated, phrase: { kind, mime: MIME[kind], bytes: all.length, durationMs: d.ms, estimated: d.estimated, ...gen, data: all } };
  }

  private take(): Buffer {
    const all = Buffer.concat(this.parts);
    this.parts = [];
    return all;
  }
}

/** Сохраняет законченные фразы в каталог прогона: t<ход>-p<номер>.<расширение>. */
export class SpeechStore {
  private n = 0;
  constructor(private readonly dir: string) {}

  save(turn: number, p: AssembledPhrase): Phrase {
    const { data, ...meta } = p;
    mkdirSync(this.dir, { recursive: true });
    this.n += 1;
    const file = join(this.dir, `t${turn}-p${this.n}.${EXT[p.kind]}`).split("\\").join("/");
    writeFileSync(file, data);
    return { ...meta, file };
  }
}
