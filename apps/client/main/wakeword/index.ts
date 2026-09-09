/**
 * Wake word — детектор фразы «Джарвис» (§1, §3, §18).
 *
 * Активирует голосовой стрим: до срабатывания аудио НЕ уходит на сервер (§0.6 privacy-инвариант).
 * W1 (2026-09-09): штатная реализация — sherpa-onnx KeywordSpotter (`hearing/sherpa-hearing.ts`),
 * работает на устройстве, ~1–2 мс на кадр. Нет пакета/моделей → MockWakeWord (ready=false):
 * гейт открыт постоянно, «Джарвис» ловится по тексту облачного STT (прежний режим).
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("wakeword");

export interface IWakeWord {
  /** Прогнать кадр PCM16. Вернуть true при детекте wake word. */
  process(pcm: Int16Array): boolean;
  /** Готова ли реальная модель (false → нужен push-to-talk fallback / wake по тексту облака). */
  readonly ready: boolean;
  /** Сбросить контекст детектора (после срабатывания/закрытия гейта). */
  reset?(): void;
}

/**
 * Mock wake word: модели нет, детектора по аудио нет (ready=false).
 * Активация в dev — явным push-to-talk (UI/горячая клавиша) через AudioCoordinator.activate().
 */
export class MockWakeWord implements IWakeWord {
  readonly ready = false;
  process(_pcm: Int16Array): boolean {
    return false;
  }
}

/** Реальный wake word (sherpa) — либо Mock, если слух не поднялся. Мягко, без падения клиента. */
export async function createWakeWord(): Promise<IWakeWord> {
  try {
    const { createSherpaHearing } = await import("../hearing/sherpa-hearing.js");
    const h = await createSherpaHearing();
    if (h) return h.wake;
  } catch (e) {
    log.warn("ошибка инициализации wake word — MockWakeWord", e instanceof Error ? e.message : String(e));
  }
  log.warn("локальный wake недоступен — wake по тексту облака (MockWakeWord)");
  return new MockWakeWord();
}
