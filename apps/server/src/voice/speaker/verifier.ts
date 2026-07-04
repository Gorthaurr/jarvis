/**
 * Верификация диктора по голосовому отпечатку (§3 «kill-фича»).
 *
 * Цель: Джарвис реагирует ТОЛЬКО на голос(а) владельца, а музыку/YouTube/чужую речь молча
 * игнорирует. Реализуется как ГЕЙТ «реагировать ли», а не «слушать ли»: отпечаток считается
 * ПАРАЛЛЕЛЬНО на том же аудио, что уже течёт в STT, и вердикт готов к концу фразы → НОЛЬ
 * добавленной задержки к ответу.
 *
 * Движок — за интерфейсом (как ISttProvider/IWakeWord): реальный (Picovoice Eagle / ONNX-
 * эмбеддер) подключается отдельно, Mock — для dev/тестов. Если движок НЕ готов (ready=false)
 * или нет ни одного enrolled-голоса — гейт ВЫКЛЮЧЕН (реагируем на всех, как раньше): фича
 * никогда не запирает пользователя до настройки.
 */

/** Голосовой отпечаток одного диктора: имя + опачные байты профиля движка. */
export interface VoiceProfile {
  /** Имя голоса («Антон», «Катя»). Уникально в хранилище. */
  name: string;
  /** Сырые байты профиля движка (Eagle/ONNX/…). В хранилище — base64. Для CAM++ — центроид 192-dim. */
  data: Uint8Array;
  /** Когда записан (unix ms). */
  createdAt: number;
  /**
   * §3 Фаза 0: размерность эмбеддинга (= data.byteLength/4 для float32). При смене модели
   * отпечатка размерность меняется → старый профиль НЕсравним. `cosine` молча режет по min(len) →
   * тихая деградация; поэтому гейт отбраковывает профиль с чужой `dim` (а не считает мусорный score).
   */
  dim?: number;
  /** §3 Фаза 0: ИД модели, которой записан профиль. Смена модели при той же `dim` → тоже несравним. */
  modelId?: string;
}

/** Совпадение говорящего с известным профилем. */
export interface SpeakerMatch {
  name: string;
  /** Уверенность [0..1]. */
  score: number;
  /** Пол по основному тону (§3 цель №2): male/female/unknown. Доп-сигнал, не основной критерий. */
  gender?: "male" | "female" | "unknown";
  /** Медианный F0 пробы (Гц) — для диагностики/калибровки; null, если речь не звонкая. */
  f0Hz?: number | null;
}

/**
 * Сессия enrollment одного голоса: кормим аудио, растёт процент готовности; finish даёт
 * байты профиля. Инкрементально — чтобы UI показывал прогресс «говорите ещё…».
 */
export interface EnrollSession {
  /** Скормить кадр PCM16 16кГц. Вернуть готовность [0..1] (1 = достаточно аудио). */
  feed(pcm: Int16Array): Promise<number>;
  /** Завершить enrollment → байты профиля (null, если аудио не хватило). */
  finish(): Promise<Uint8Array | null>;
  /** Прервать и освободить ресурсы. */
  cancel(): void;
}

/** Верификатор диктора (enrollment + опознание). Пускаемо за интерфейсом. */
export interface ISpeakerVerifier {
  /** Готов ли движок. false → гейт диктора выключен (реагируем на всех). */
  readonly ready: boolean;
  /** Минимум секунд речи для надёжного enrollment (для подсказки в UI). */
  readonly enrollSeconds: number;
  /**
   * Порог косинуса «свой/чужой» (= acceptThreshold). Оставлен для обратной совместимости;
   * новый код использует пару acceptThreshold/rejectThreshold (Фаза 2).
   */
  readonly threshold: number;
  /** §3 Фаза 2: score ≥ accept → уверенно «свой» (пускаем, открываем окно доверия). */
  readonly acceptThreshold: number;
  /**
   * §3 Фаза 2: score < reject → уверенно «чужой» (глушим). Зона [reject, accept) → «не решили»
   * (fail-open: пропускаем, чтобы лёгкая просадка score не запирала владельца). reject ≤ accept.
   */
  readonly rejectThreshold: number;
  /** §3 Фаза 0: размерность эмбеддинга движка (для отбраковки профиля чужой размерности). */
  readonly dim: number;
  /** §3 Фаза 0: ИД активной модели отпечатка (тег для новых профилей + проверка совместимости). */
  readonly modelId: string;
  /** Начать enrollment нового голоса. */
  enroll(): EnrollSession;
  /**
   * ЛУЧШЕЕ совпадение говорящего среди профилей (с косинус-оценкой), БЕЗ применения порога —
   * чтобы гейт сам различал «чужой» (score<threshold → глушим) и «не удалось посчитать»
   * (null: слишком короткий/тихий фрагмент → НЕ запираем, пропускаем). Порог применяет гейт.
   */
  identify(pcm: Int16Array, profiles: readonly VoiceProfile[]): Promise<SpeakerMatch | null>;
}

/**
 * Mock-верификатор: движок не подключён (ready=false → гейт выключен, реагируем на всех).
 * Для тестов поведение настраивается (ready + фиксированный результат identify).
 */
export class MockSpeakerVerifier implements ISpeakerVerifier {
  readonly ready: boolean;
  readonly enrollSeconds = 20;
  readonly threshold: number;
  readonly acceptThreshold: number;
  readonly rejectThreshold: number;
  readonly dim: number;
  readonly modelId: string;
  /** Что вернёт identify (для тестов гейта). По умолчанию — «свой» (первый профиль, score 1). */
  private readonly matcher: (profiles: readonly VoiceProfile[]) => SpeakerMatch | null;

  constructor(opts?: {
    ready?: boolean;
    threshold?: number;
    acceptThreshold?: number;
    rejectThreshold?: number;
    dim?: number;
    modelId?: string;
    match?: (profiles: readonly VoiceProfile[]) => SpeakerMatch | null;
  }) {
    this.ready = opts?.ready ?? false;
    this.threshold = opts?.threshold ?? 0.5;
    // По умолчанию accept=reject=threshold → поведение как с одним порогом (обратная совместимость).
    this.acceptThreshold = opts?.acceptThreshold ?? this.threshold;
    this.rejectThreshold = opts?.rejectThreshold ?? this.acceptThreshold;
    this.dim = opts?.dim ?? 192;
    this.modelId = opts?.modelId ?? "mock";
    this.matcher =
      opts?.match ??
      ((profiles) => (profiles.length > 0 ? { name: profiles[0]!.name, score: 1 } : null));
  }

  enroll(): EnrollSession {
    let frames = 0;
    return {
      async feed() {
        frames += 1;
        return Math.min(1, frames / 50); // условно «набираем» за ~50 кадров
      },
      async finish() {
        return frames > 0 ? new Uint8Array([1, 2, 3]) : null;
      },
      cancel() {
        frames = 0;
      },
    };
  }

  async identify(_pcm: Int16Array, profiles: readonly VoiceProfile[]): Promise<SpeakerMatch | null> {
    return this.matcher(profiles);
  }
}
