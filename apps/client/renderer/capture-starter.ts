/**
 * Стартовый подъём микрофона с повтором (ревью 2026-09-24, B-F4 / T-F9 / H-L1).
 *
 * Корень (клиентский лог 24.09 12:20:10): getUserMedia на старте упал — «микрофон недоступен:
 * [object DOMException]», — и больше НИКТО не пытался: ретрай H18 живёт только в `AudioCapture.restart()`
 * (уже поднятого захвата), а стартовый провал просто обнулял ссылку. При этом renderer ВСЁ РАВНО звал
 * `jarvis.activate()`, и main писал «слух включён» — Джарвис был глух до перезапуска клиента, а лог врал.
 *
 * Здесь: повтор с тем же бэкоффом, что у H18 (1 с → 30 с), текст ошибки собирается из name + message
 * (Chromium при пересылке console-message превращает DOMException в «[object DOMException]»), и
 * `activate()` зовётся ТОЛЬКО после реального подъёма захвата — с перепроверкой mute на момент успеха.
 * Модуль чистый (DI), потому что DOM-тестов в клиенте нет: логика проверяется на подделках.
 */
import { RESTART_RETRY_MAX_MS, RESTART_RETRY_MIN_MS } from "./audio.js";

/** «NotReadableError: Could not start audio source» вместо «[object DOMException]». */
export function describeMediaError(e: unknown): string {
  if (e && typeof e === "object") {
    const { name, message } = e as { name?: unknown; message?: unknown };
    const parts = [name, message].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (parts.length > 0) return parts.join(": ");
  }
  return String(e);
}

/** Человеческая причина по имени ошибки getUserMedia — что владельцу сделать руками. */
export function micErrorHint(e: unknown): string {
  const name = e && typeof e === "object" ? (e as { name?: unknown }).name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Нет разрешения на микрофон — Параметры Windows → Конфиденциальность → Микрофон";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Микрофон не найден — подключите его";
  if (name === "NotReadableError" || name === "AbortError") return "Микрофон занят другой программой";
  return "Микрофон недоступен";
}

export interface CaptureFailInfo {
  error: string;
  hint: string;
  attempt: number;
  retryInMs: number;
}

export interface CaptureStarterDeps {
  /** Поднять захват. Бросает, если микрофон не дали (частичный подъём добивает сам). */
  start(): Promise<void>;
  onUp(): void;
  onFail(info: CaptureFailInfo): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class CaptureStarter {
  private up = false;
  private inFlight: Promise<boolean> | null = null;
  private timer: unknown = null;
  private delay = RESTART_RETRY_MIN_MS;
  private attempt = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly deps: CaptureStarterDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get isUp(): boolean {
    return this.up;
  }

  /**
   * Поднять захват сейчас. Идемпотентно: поднят — no-op; попытка в полёте — та же; ждёт ретрай —
   * пробуем немедленно (кнопка микрофона = «попробуй ещё раз сейчас»), бэкофф при этом не сбрасываем.
   */
  ensure(): Promise<boolean> {
    if (this.up) return Promise.resolve(true);
    if (this.inFlight) return this.inFlight;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.inFlight = this.tryOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async tryOnce(): Promise<boolean> {
    this.attempt += 1;
    try {
      await this.deps.start();
    } catch (e) {
      const retryInMs = this.delay;
      this.delay = Math.min(this.delay * 2, RESTART_RETRY_MAX_MS);
      this.deps.onFail({ error: describeMediaError(e), hint: micErrorHint(e), attempt: this.attempt, retryInMs });
      this.timer = this.setTimer(() => {
        this.timer = null;
        void this.ensure();
      }, retryInMs);
      return false;
    }
    this.up = true;
    this.delay = RESTART_RETRY_MIN_MS;
    this.attempt = 0;
    this.deps.onUp();
    return true;
  }
}

export interface MicBootDeps {
  startCapture(): Promise<void>;
  /** Воля владельца НА МОМЕНТ успеха: поздний подъём не должен включать слух, выключенный за это время. */
  isMuted(): boolean;
  bridge: { activate(): void };
  ui: { up(): void; down(info: CaptureFailInfo): void };
  setTimer?: CaptureStarterDeps["setTimer"];
  clearTimer?: CaptureStarterDeps["clearTimer"];
}

/** Проводка старта: `activate()` уходит в main только когда захват реально поднят и владелец не выключил слух. */
export function createMicBoot(d: MicBootDeps): CaptureStarter {
  return new CaptureStarter({
    start: d.startCapture,
    onUp: () => {
      d.ui.up();
      if (!d.isMuted()) d.bridge.activate();
    },
    onFail: (info) => d.ui.down(info),
    setTimer: d.setTimer,
    clearTimer: d.clearTimer,
  });
}
