/**
 * «Фейковый рендерер» воспроизведения: то, что делает AudioPlayback в renderer/audio.ts, без DOM. Без него сервер не получит
 * `audio.playback` (очередь озвучки ждёт оптимистичные 1,5 с, следующая реплика уезжает «пачкой») и `audio.played`
 * (метрика mouth-to-ear молчит). Звук «играет» столько, сколько он длится (÷ rate: в ускоренном прогоне можно играть быстрее);
 * пока играет — `audio.playback{active:true}` и координатору `setPlaybackActive(true)` (окно barge-in), по окончании —
 * `false`. audio.played{gen,ts} — на первый звук хода, один раз на gen. Не моделируем: подавление отставших чанков после
 * barge-in (400 мс) и дренаж-таймеры PCM (DRAIN 11 с / ORPHAN 12 с) — они про сбои сети, а не про штатный ход.
 */
import { type AssembledPhrase, type Phrase, SpeechAssembler, type SpeakChunkIn } from "./speech-store.js";

export interface PlayerPorts {
  sendPlayback(active: boolean): void;
  sendPlayed(gen: number, ts: number): void;
  setCoordinatorActive(active: boolean): void;
  /** Законченная фраза (для сохранения в файл). */
  onPhrase(p: AssembledPhrase): void;
}

export class FakePlayer {
  private readonly asm = new SpeechAssembler();
  private playEnd = 0;
  private open = false; // pcm-поток начался, last ещё нет
  private on = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly played = new Set<number>();
  /** Все фразы, которые довели до конца, — для отчёта. */
  readonly phrases: Phrase[] = [];

  constructor(private readonly ports: PlayerPorts, private readonly rate = 1) {}

  get active(): boolean {
    return this.on;
  }

  onChunk(c: SpeakChunkIn): void {
    const r = this.asm.push(c);
    this.open = !c.last && (c.format === "pcm16" || this.open);
    if (r.phrase) {
      this.open = false;
      this.ports.onPhrase(r.phrase);
    }
    if (r.pieceMs === null) return; // mp3/wav ещё копится — играть нечего
    const now = Date.now();
    const start = Math.max(now, this.playEnd);
    this.playEnd = start + r.pieceMs / this.rate;
    this.setActive(true);
    if (c.gen !== undefined && !this.played.has(c.gen)) {
      this.played.add(c.gen);
      const gen = c.gen;
      if (start <= now) this.ports.sendPlayed(gen, now);
      else setTimeout(() => this.ports.sendPlayed(gen, start), start - now).unref?.();
    }
    this.rearm();
  }

  /** barge-in / «стоп»: звук оборван — как playback.stop() в renderer. */
  stop(): void {
    this.playEnd = 0;
    this.open = false;
    this.setActive(false);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setActive(a: boolean): void {
    if (this.on === a) return;
    this.on = a;
    this.ports.setCoordinatorActive(a);
    this.ports.sendPlayback(a);
  }

  private rearm(pollMs = 0): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = pollMs || Math.max(0, this.playEnd - Date.now()) + 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.open && Date.now() < this.playEnd + 11_000) return this.rearm(100); // ждём хвост pcm-потока (DRAIN 11 с)
      this.setActive(false);
    }, wait);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
