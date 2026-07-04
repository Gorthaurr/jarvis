/**
 * PhraseSpeaker — одна «говорящая сессия» из НЕСКОЛЬКИХ фраз (§10 realtime).
 *
 * Brain отдаёт реплику пофразно (token-streaming); чтобы машина состояний голоса не
 * «мигала» speaking↔listening между фразами, эта сессия:
 *   - синтезирует фразы ПО ОЧЕРЕДИ (одна за другой, в порядке поступления);
 *   - на ПЕРВОМ аудио-чанке ПЕРВОЙ фразы — один раз onSpeaking() (→ speak_start);
 *   - на исчерпании очереди ПОСЛЕ finish() — один раз onDone() (→ speak_done);
 *   - barge-in/stop рубит текущий синтез и всю очередь (cancel()).
 *
 * Серийный синтез естественно перекрывается с воспроизведением на клиенте: пока клиент
 * проигрывает фразу N (секунды), сервер уже синтезирует фразу N+1 — без переусложнения.
 * Поколение оборота (gen) проверяется через isLive(): поздние колбэки barge-in глохнут.
 */
import type { Logger } from "@jarvis/shared";
import type { TtsChunk, TtsStream } from "../integrations/voice-providers.js";

export interface PhraseSpeakerDeps {
  /** Синтез одной фразы (с voice-опциями режима §11 — настраивает вызывающий). */
  synthesize: (text: string) => TtsStream;
  /** Отправить аудио-чанк клиенту (speak.chunk, §5). */
  sendChunk: (c: TtsChunk) => void;
  /** Первый звук ПЕРВОЙ фразы пошёл клиенту → войти в speaking (один раз). */
  onSpeaking: () => void;
  /** Вся реплика произнесена (очередь пуста после finish) → speak_done (один раз). */
  onDone: () => void;
  /** Актуально ли поколение оборота: barge-in/stop инвалидируют (поздние колбэки глохнут). */
  isLive: () => boolean;
  log?: Logger;
}

export class PhraseSpeaker {
  private readonly queue: string[] = [];
  private current: TtsStream | null = null;
  private finished = false; // brain закончил генерацию (done) — больше фраз не будет
  private spoke = false; // speak_start уже эмитнут
  private doneEmitted = false;
  private cancelled = false;

  constructor(private readonly deps: PhraseSpeakerDeps) {}

  /** Идёт ли ещё работа (есть текущий синтез/очередь/ждём финал). */
  get active(): boolean {
    return !this.cancelled && !this.doneEmitted;
  }

  /** Добавить готовую фразу в очередь синтеза (стрим из brain). */
  push(sentence: string): void {
    if (this.cancelled || this.doneEmitted) return;
    const s = sentence.trim();
    if (!s) return;
    this.queue.push(s);
    if (!this.current) this.next();
  }

  /** Brain закончил генерацию: после слива очереди → onDone. */
  finish(): void {
    if (this.cancelled) return;
    this.finished = true;
    if (!this.current && this.queue.length === 0) this.emitDone();
  }

  /** Barge-in/stop: оборвать текущий синтез и очередь, больше ничего не эмитить. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue.length = 0;
    if (this.current) {
      this.current.cancel();
      this.current = null;
    }
  }

  private next(): void {
    if (this.cancelled) return;
    const text = this.queue.shift();
    if (text === undefined) {
      if (this.finished) this.emitDone();
      return;
    }
    const stream = this.deps.synthesize(text);
    this.current = stream;
    let firstChunk = true;
    stream.onChunk((c) => {
      if (!this.deps.isLive() || this.cancelled) return;
      if (firstChunk) {
        firstChunk = false;
        if (!this.spoke) {
          this.spoke = true;
          this.deps.onSpeaking();
        }
      }
      this.deps.sendChunk(c);
    });
    stream.onError((e) => this.deps.log?.warn("ошибка синтеза фразы", e.message));
    stream.onDone(() => {
      if (this.cancelled) return;
      // current мог уже смениться при гонке — сбрасываем только «свой» стрим.
      if (this.current === stream) this.current = null;
      if (!this.deps.isLive()) return;
      this.next(); // следующая фраза, либо (если очередь пуста и finished) — onDone
    });
  }

  private emitDone(): void {
    if (this.doneEmitted || this.cancelled) return;
    this.doneEmitted = true;
    if (!this.deps.isLive()) return;
    this.deps.onDone();
  }
}
