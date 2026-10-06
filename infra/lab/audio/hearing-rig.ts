import { HearingProbe, RigClock, probeLogger } from "./hearing-probe.js";
export { HearingProbe,RigClock } from "./hearing-probe.js";
/**
 * HearingRig — НАСТОЯЩИЙ клиентский слух в Node: AudioCoordinator (apps/client/main/audio) + sherpa KWS «Джарвис» + Silero VAD.
 * Кадры (320 сэмплов) подаются в `ingest()` — граница renderer→main (IPC.pushPcm). Всё, что координатор шлёт наружу
 * (audio.frame/audio.vad/audio.wake_rescue), уходит в переданные sinks; стенд направляет их на LabClient, корпусный отчёт — в счётчики.
 * Часы: realtime — Date.now, fast — виртуальные (+20 мс на кадр), их читают barge-in, wake-miss, rescue-link. ЧЕСТНО: GateCloser
 * и таймеры сервера остаются РЕАЛЬНЫМИ, поэтому fast годится для слуха (KWS/VAD/подстраховка клиента), но не для серверных таймингов.
 */
import { AudioCoordinator } from "../../../apps/client/main/audio/index.js";
import { type SherpaHearing, createSherpaHearing, hearingModelsDir, hearingModelsPresent } from "../../../apps/client/main/hearing/sherpa-hearing.js";
import { FRAME_MS } from "./mic-model.js";

export interface RigSinks {
  frame(pcm: Int16Array, seq: number): void;
  vad(state: string): void;
  /** true — «сокет открыт, фрагмент ушёл». */
  rescue(pcm: Int16Array, meta: { ms: number; peak: number }): boolean;
  bargeIn?(): void;
}

/** Мост колбэка onWake sherpa (создаётся при загрузке) к текущему rig: движки живут дольше rig-ов. */
export interface WakeTap {
  on?: (keyword: string) => void;
}
export type HearingLoad = { ok: true; hearing: SherpaHearing; tap: WakeTap } | { ok: false; reason: string };

/** Поднять sherpa из ~/.jarvis/models; нет моделей/пакета — честная причина (вызывающий делает skip). */
export async function loadHearing(dir = hearingModelsDir()): Promise<HearingLoad> {
  if (!hearingModelsPresent(dir)) return { ok: false, reason: `модели слуха не найдены в ${dir} (node apps/client/scripts/fetch-hearing-models.mjs)` };
  const tap: WakeTap = {};
  const hearing = await createSherpaHearing({ dir, onWake: (kw) => tap.on?.(kw) });
  return hearing ? { ok: true, hearing, tap } : { ok: false, reason: "sherpa-onnx-node не загрузился или путь моделей не ASCII (см. WARN sherpa-hearing)" };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HearingRig {
  readonly ac: AudioCoordinator;
  readonly probe = new HearingProbe();
  readonly clock = new RigClock();
  private seq = 0;

  /** `hearing` — уже поднятые движки (их можно переиспользовать между rig-ами: reset() при каждом feed). */
  constructor(readonly hearing: SherpaHearing, sinks: RigSinks, tap?: WakeTap) {
    if (tap) tap.on = (kw) => this.noteWake(kw);
    const p = this.probe;
    this.ac = new AudioCoordinator({
      sendFrame: (pcm) => {
        p.framesSent += 1;
        sinks.frame(pcm, this.seq++);
      },
      sendVad: (s) => {
        p.vad.push(s);
        sinks.vad(s);
      },
      sendRescue: (pcm, meta) => {
        p.rescueCount += 1;
        const ok = sinks.rescue(pcm, meta);
        if (ok) p.rescueSent = true;
        return ok;
      },
      onBargeIn: () => {
        p.bargeIns += 1;
        sinks.bargeIn?.();
      },
      now: this.clock.now,
      log: probeLogger(p),
    });
    this.ac.setEngines({ wake: hearing.wake, vad: hearing.vad });
    this.ac.syncServerIdle();
    this.ac.activate(); // с локальным wake гейт остаётся закрытым до «Джарвис» (§0.6)
  }

  private noteWake(keyword: string): void {
    this.probe.wakeFired = true;
    this.probe.wakeKeywords.push(keyword);
  }

  /** Подать кадры. realtime — темп 20 мс/кадр по стенным часам; иначе виртуальные часы и без пауз. */
  async feed(frames: Int16Array[], realtime: boolean, onTick?: (i: number) => void): Promise<void> {
    this.clock.use(realtime);
    this.hearing.vad.reset();
    this.hearing.wake.reset(); // левый контекст энкодера от прошлого файла (см. SherpaWakeWord.reset)
    const t0 = Date.now();
    for (let i = 0; i < frames.length; i += 1) {
      if (realtime) {
        const wait = t0 + i * FRAME_MS - Date.now();
        if (wait > 0) await sleep(wait);
      } else {
        this.clock.tick(FRAME_MS);
        if (i % 25 === 0) await new Promise<void>((r) => setImmediate(r)); // дать WS/таймерам подышать
      }
      this.ac.ingest(frames[i] as Int16Array);
      onTick?.(i);
    }
  }

  /** Снять таймеры координатора (GateCloser реальный): mute закрывает гейт и очищает их. */
  dispose(): void {
    this.ac.mute();
    this.hearing.wake.reset();
    this.hearing.vad.reset();
  }
}
