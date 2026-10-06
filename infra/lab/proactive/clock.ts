/**
 * ЕДИНЫЕ виртуальные часы проактива: fake timers vitest подменяют И Date, И таймеры, поэтому один `advance` двигает
 * всё разом (напоминания, тики watch/ambient, TTL очереди озвучки, дренаж 20 с). Ставить ДО создания сервисов:
 * они берут `Date.now` по ссылке в конструкторе. Часовой пояс задаётся явно (хост может быть в любом).
 */
import { vi } from "vitest";
import { FAULT } from "./kit.js";

export interface LabClock {
  now(): number;
  /** Локальный момент из строки без смещения ("2026-07-29T09:00:00") в текущем поясе. */
  at(local: string): number;
  /** Человекочитаемое локальное время с мс: "2026-07-29 09:00:00.000". */
  fmt(ts?: number): string;
  /** Продвинуть виртуальное время и отработать все таймеры по пути (в том числе асинхронные тики). */
  advance(ms: number): Promise<void>;
  advanceTo(local: string): Promise<void>;
  /** Отработать всё, что готово «прямо сейчас» (микрозадачи и таймеры с нулевой задержкой). */
  settle(): Promise<void>;
  /** «Сон ПК»: настенные часы прыгнули, таймеры НЕ сработали (как setSystemTime). */
  jump(ms: number): void;
  /** Смерть процесса: все таймеры пропадают, время остаётся (clearAllTimers сам сбрасывает Date к моменту установки). */
  wipeTimers(): void;
  setTz(tz: string): void;
  restore(): void;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

export function installClock(startLocal: string, tz: string): LabClock {
  const prevTz = process.env.TZ;
  process.env.TZ = tz;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(startLocal));
  const at = (local: string): number => new Date(local).getTime();
  const clock: LabClock = {
    now: () => Date.now(),
    at,
    fmt(ts = Date.now()) {
      const d = new Date(ts);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    },
    async advance(ms) {
      if (FAULT === "noadvance") return; // неисправность сценария: время стоит
      await vi.advanceTimersByTimeAsync(ms);
    },
    async advanceTo(local) {
      const delta = at(local) - Date.now();
      if (delta < 0) throw new Error(`advanceTo(${local}): момент в прошлом (${clock.fmt()})`);
      await clock.advance(delta);
    },
    settle: () => vi.advanceTimersByTimeAsync(0).then(() => undefined),
    jump: (ms) => vi.setSystemTime(Date.now() + ms),
    wipeTimers() {
      const keep = Date.now();
      vi.clearAllTimers();
      vi.setSystemTime(keep);
    },
    setTz(next) {
      process.env.TZ = next;
    },
    restore() {
      vi.clearAllTimers();
      vi.useRealTimers();
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    },
  };
  return clock;
}
