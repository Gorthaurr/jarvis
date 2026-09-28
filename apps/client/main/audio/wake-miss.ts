/**
 * Видимость ПРОМАХА локального wake (ревью 2026-09-24, B-F8).
 *
 * Корень: при закрытом гейте кадры идут только в sherpa KWS. Сказал владелец «Джарвис», а детектор
 * промолчал — в логе НИЧЕГО: ни «слышал речь», ни «не узнал слово». Разбор «вчера не слышал» был слеп
 * именно в этой точке, а запасного пути (кнопка/хоткей) не было.
 *
 * Здесь — отдельный дешёвый энергетический детектор речи ТОЛЬКО для телеметрии: основной VAD на
 * закрытом гейте гонять нельзя — он станет `speaking` ДО открытия гейта, и speech_start новой реплики
 * серверу уже не уйдёт (та же поломка, что у залипшего VAD). Реплико-подобный отрезок речи (0,5–4 с)
 * без срабатывания wake = кандидат в промах; лог не чаще раза в `throttleMs`, со счётчиком за окно.
 *
 * Скора KWS нет: sherpa `KeywordSpotter.getResult` отдаёт {start_time, keyword, timestamps, tokens} и
 * пустой keyword при промахе — «насколько близко было» он не сообщает. Поэтому в логе — длительность и
 * пик уровня отрезка: этого хватает, чтобы отличить «владелец говорил громко и ясно» от «шорох».
 */
import type { Logger } from "@jarvis/shared";
import { EnergyVad, rms } from "../vad/index.js";
import { SegmentRecorder } from "./segment-recorder.js";

/** Частота кадров слуха: 16 кГц mono (см. renderer/audio-worklet.js). */
const SAMPLE_RATE = 16_000;

export interface WakeMissOptions {
  log: Logger;
  now?: () => number;
  /** Не чаще одного лога за это окно (мс). */
  throttleMs?: number;
  /** Отрезок речи короче — щелчок/шорох, не реплика (включает хвост hangover ~240 мс). */
  minSpeechMs?: number;
  /** Отрезок длиннее — фон (ТВ/игра), а не обращение. */
  maxSpeechMs?: number;
  /**
   * Подстраховка «Джарвис» (28.09): отрезок-кандидат с аудио. Зовётся для КАЖДОГО подходящего отрезка (не только
   * для залогированных): реплико-подобная длина и достаточно громко — тихое бормотание/шорох в облако не идёт.
   */
  onCandidate?: (seg: { pcm: Int16Array; ms: number; peak: number }) => void;
  /** Короче — слово «Джарвис» с хвостом VAD не уместится (деф 700 мс). */
  rescueMinMs?: number;
  /** Тише — не голос у микрофона (деф пик rms 6000: промахи 28.09 были 10–16K, обычная речь ~4K+). */
  rescueMinPeak?: number;
}

export class WakeMissMonitor {
  /** Потолок «вечной речи» выключен: сплошной фон просто уйдёт за maxSpeechMs и не станет кандидатом. */
  // hangover 25 кадров (500 мс, ревью 28.09 B4): пауза между «Джарвис» и командой (~0,3–0,4 с) не режет реплику на два
  // отрезка — иначе первый (голое «Джарвис») уходил бы отдельным фрагментом, а команда терялась.
  private readonly vad = new EnergyVad({ threshold: 700, hangoverFrames: 25, onsetFrames: 3, maxSpeechFrames: 0 });
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly recorder = new SegmentRecorder();
  private readonly onCandidate?: WakeMissOptions["onCandidate"];
  private readonly rescueMinMs: number;
  private readonly rescueMinPeak: number;
  /** Длительность текущего отрезка речи (по сэмплам, не по часам — кадры могут приходить пачкой). */
  private segMs = 0;
  private segPeak = 0;
  private missed = 0;
  private lastLogAt = Number.NEGATIVE_INFINITY;

  constructor(opts: WakeMissOptions) {
    this.log = opts.log;
    this.now = opts.now ?? (() => Date.now());
    this.throttleMs = opts.throttleMs ?? 60_000;
    this.minMs = opts.minSpeechMs ?? 500;
    this.maxMs = opts.maxSpeechMs ?? 4_000;
    this.onCandidate = opts.onCandidate;
    this.rescueMinMs = opts.rescueMinMs ?? 700;
    this.rescueMinPeak = opts.rescueMinPeak ?? 6_000;
  }

  /** Кадр при закрытом гейте, на котором wake НЕ сработал. */
  frame(pcm: Int16Array): void {
    const sig = this.vad.process(pcm);
    if (this.onCandidate) this.recorder.push(pcm, sig, this.vad.speaking);
    if (this.vad.speaking || sig === "speech_end") {
      this.segMs += (pcm.length / SAMPLE_RATE) * 1000;
      const level = rms(pcm);
      if (level > this.segPeak) this.segPeak = level;
    }
    if (sig === "speech_end") this.closeSegment();
  }

  /** Гейт открылся (wake сработал = попадание) или закрылся — отрезок обрывается без вердикта. */
  reset(): void {
    this.vad.reset();
    this.recorder.reset();
    this.segMs = 0;
    this.segPeak = 0;
  }

  /** Сколько промахов накоплено с последнего лога (для тестов/диагностики). */
  get pending(): number {
    return this.missed;
  }

  private closeSegment(): void {
    const ms = this.segMs;
    const peak = this.segPeak;
    this.segMs = 0;
    this.segPeak = 0;
    const audio = this.onCandidate ? this.recorder.take() : null;
    if (ms < this.minMs || ms > this.maxMs) return;
    if (audio && ms >= this.rescueMinMs && peak >= this.rescueMinPeak) this.onCandidate?.({ pcm: audio, ms: Math.round(ms), peak: Math.round(peak) });
    this.missed += 1;
    const t = this.now();
    if (t - this.lastLogAt < this.throttleMs) return;
    this.lastLogAt = t;
    this.log.info("wake: речь при закрытом гейте, «Джарвис» не распознан (кандидат в промах KWS)", {
      segments: this.missed,
      lastMs: Math.round(ms),
      lastPeakRms: Math.round(peak),
      kwsScore: "sherpa не отдаёт",
      hint: "не сработало — кнопка микрофона или Ctrl+Alt+J (push-to-talk)",
    });
    this.missed = 0;
  }
}
