/**
 * Wake word — детектор фразы «Джарвис» (§1, §3, §18).
 *
 * Активирует голосовой стрим: до срабатывания аудио НЕ уходит на сервер
 * (§0.6 privacy-инвариант). Штатно — openWakeWord/Porcupine через onnxruntime-node
 * (модель «hey_jarvis» / кастомная RU «Джарвис» — валидация на M1, §18).
 * onnxruntime подключается ОПЦИОНАЛЬНО (динамический импорт): если рантайма/модели
 * нет — используется MockWakeWord (dev: активация push-to-talk через UI).
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("wakeword");

export interface IWakeWord {
  /** Прогнать кадр PCM16. Вернуть true при детекте wake word. */
  process(pcm: Int16Array): boolean;
  /** Готова ли реальная модель (false → нужен push-to-talk fallback). */
  readonly ready: boolean;
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

/**
 * Реальный wake word поверх onnxruntime-node. Загрузка отложенная и мягкая:
 * при отсутствии пакета/модели возвращаем MockWakeWord, не роняя клиент.
 * // TODO(M1): валидация RU-произношения «Джарвис» (§18) — может потребоваться
 *   кастомная модель (openWakeWord тренируется на синтетике; Porcupine — консоль).
 */
export async function createWakeWord(modelPath?: string): Promise<IWakeWord> {
  if (!modelPath) {
    log.warn("модель wake word не задана — push-to-talk режим (MockWakeWord)");
    return new MockWakeWord();
  }
  try {
    // Динамический импорт через переменную: TS/esbuild не резолвят статически,
    // onnxruntime-node остаётся опциональной runtime-зависимостью.
    const spec = "onnxruntime-node";
    const ort = (await import(spec).catch(() => null)) as {
      InferenceSession?: { create(p: string): Promise<unknown> };
    } | null;
    if (!ort?.InferenceSession) {
      log.warn("onnxruntime-node недоступен — MockWakeWord");
      return new MockWakeWord();
    }
    // TODO(M1): реальная инференс-петля openWakeWord (мел-спектр → модель → порог).
    log.info("onnxruntime доступен; инференс wake word — TODO(M1)");
    return new MockWakeWord();
  } catch (e) {
    log.warn("ошибка инициализации wake word — MockWakeWord", e instanceof Error ? e.message : String(e));
    return new MockWakeWord();
  }
}
