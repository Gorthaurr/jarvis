/**
 * Определение конца реплики (turn detection, §10).
 *
 * Поверх Silero VAD (события speech_end) накладывается «семантический» детектор:
 * пауза не всегда = конец мысли («я думаю… что да»). Штатно это мультиязычная
 * open-weights модель LiveKit; здесь — интерфейс + эвристический детектор для RU
 * (валидация на русском — M1, §10). Кастомный turn-manager НЕ пишем, пока штатный
 * не упрётся (§10).
 */

/** Предиктор завершённости реплики: 0..1 (1 = фраза точно закончена). */
export interface ISemanticTurnDetector {
  predictComplete(text: string): number;
}

export interface TurnConfig {
  /** Жёсткий эндпоинт: тишины столько → конец реплики независимо от семантики. */
  maxSilenceMs: number;
  /** Минимальная тишина перед мягким (семантическим) эндпоинтом. */
  minSilenceMs: number;
  /** Порог вероятности завершённости для мягкого эндпоинта. */
  completeThreshold: number;
}

/** env-целое с клампом (тюнинг эндпоинта без перекомпиляции). */
function envInt(name: string, def: number, lo: number, hi: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  // §10 СКОРОСТЬ: «мёртвое время» эндпоинта (пауза после речи до старта Opus) — прямой вклад в
  // ощущаемую задержку. ЖЁСТКИЙ потолок тишины финализирует независимо от семантики; на Deepgram
  // есть interim, поэтому семантический эндпоинт срабатывает РАНЬШЕ потолка на завершённой фразе
  // (tick() от minSilenceMs). Понижено 800→650 / 200→120 ради отзывчивости (TRAILING_INCOMPLETE
  // ловит «висящие» союзы → их не рубим до потолка). Тюнится env, если режет на полуслове — поднять.
  // 650/120 РЕЗАЛО на полуслове (юзер: «не дослушивает») — подняли обратно патиентнее: 850мс
  // жёсткий потолок, 280мс до семантической проверки, порог 0.75 (рано финализируем только при
  // явно завершённой фразе/терминальной пунктуации). Срезать «мёртвое время» лучше не здесь, а
  // персоной (меньше слов) — обрыв речи хуже лишних мс.
  maxSilenceMs: envInt("JARVIS_TURN_MAX_SILENCE_MS", 850, 300, 1500),
  minSilenceMs: envInt("JARVIS_TURN_MIN_SILENCE_MS", 280, 50, 600),
  completeThreshold: envInt("JARVIS_TURN_COMPLETE_PCT", 75, 30, 95) / 100,
};

/** Незавершающие хвосты RU — после них пауза почти наверняка временная. */
const TRAILING_INCOMPLETE = new Set([
  "и", "а", "но", "или", "что", "чтобы", "потому", "если", "когда", "как",
  "то", "так", "это", "в", "на", "с", "к", "по", "за", "для", "от", "до",
  "мне", "мой", "моя", "хочу", "давай", "сделай", "значит", "ну", "э", "эм",
]);

/** Завершающая пунктуация. */
const TERMINAL_PUNCT = /[.!?…]$/u;

/**
 * Эвристический семантический детектор (RU). Заглушка под штатную модель LiveKit:
 * высокая вероятность завершённости при терминальной пунктуации или «полноценном»
 * последнем слове; низкая — при незавершающем хвосте/совсем короткой фразе.
 */
export class HeuristicTurnDetector implements ISemanticTurnDetector {
  predictComplete(text: string): number {
    const t = text.trim().toLowerCase();
    if (t.length === 0) return 0.2;
    if (TERMINAL_PUNCT.test(t)) return 0.95;

    const words = t.split(/\s+/u);
    const last = words[words.length - 1] ?? "";
    if (TRAILING_INCOMPLETE.has(last)) return 0.15; // явно «висит» на союзе/предлоге
    if (words.length <= 1) return 0.4; // одно слово — может быть началом
    if (words.length >= 4) return 0.7; // достаточно длинная законченная мысль
    return 0.55;
  }
}

export type EndpointDecision = "endpoint" | "wait";

/**
 * Чистое решение об эндпоинте по тексту + длительности тишины.
 * Жёсткий порог тишины перекрывает семантику (чтобы не зависнуть на «эм…»).
 */
export function decideEndpoint(
  text: string,
  silenceMs: number,
  detector: ISemanticTurnDetector,
  config: TurnConfig = DEFAULT_TURN_CONFIG,
): EndpointDecision {
  if (silenceMs >= config.maxSilenceMs) return "endpoint";
  if (silenceMs < config.minSilenceMs) return "wait";
  return detector.predictComplete(text) >= config.completeThreshold ? "endpoint" : "wait";
}

/**
 * Stateful-обёртка: копит последний interim-текст и время начала тишины,
 * решает по приходу speech_end / по таймеру. Время — через инъектируемые часы
 * (тестируемость без реального времени).
 */
export class TurnDetector {
  private lastText = "";
  private silenceStartedAt: number | null = null;

  constructor(
    private readonly detector: ISemanticTurnDetector = new HeuristicTurnDetector(),
    private readonly config: TurnConfig = DEFAULT_TURN_CONFIG,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Минимум тишины перед семантической проверкой (мс) — для расписания опроса в пайплайне. */
  get minSilenceMs(): number {
    return this.config.minSilenceMs;
  }
  /** Жёсткий потолок тишины (мс) — после него эндпоинт безусловен. */
  get maxSilenceMs(): number {
    return this.config.maxSilenceMs;
  }

  /** Обновить накопленную гипотезу (interim-результат STT, §10). */
  onInterim(text: string): void {
    this.lastText = text;
  }

  /** Начало речи — сбрасываем счётчик тишины. */
  onSpeechStart(): void {
    this.silenceStartedAt = null;
  }

  /** Конец речи (VAD) — фиксируем старт тишины, возвращаем решение. */
  onSpeechEnd(): EndpointDecision {
    const t = this.now();
    if (this.silenceStartedAt === null) this.silenceStartedAt = t;
    const silenceMs = t - this.silenceStartedAt;
    const decision = decideEndpoint(this.lastText, silenceMs, this.detector, this.config);
    if (decision === "endpoint") this.reset();
    return decision;
  }

  /** Принудительная проверка по таймеру (если тишина затянулась). */
  tick(): EndpointDecision {
    if (this.silenceStartedAt === null) return "wait";
    const silenceMs = this.now() - this.silenceStartedAt;
    const decision = decideEndpoint(this.lastText, silenceMs, this.detector, this.config);
    if (decision === "endpoint") this.reset();
    return decision;
  }

  /**
   * §Волна2 (2.6): STT-провайдер САМ зафиксировал конец фразы (Deepgram speech_final = речь +
   * ~300мс тишины по его VAD) — это авторитетный сигнал тишины, но СЕМАНТИЧЕСКОЕ вето сохраняем:
   * «висящий союз/предлог» (TRAILING_INCOMPLETE → 0.15) и одиночное слово (0.4) не рубим — их
   * дорешает клиентский VAD-путь/потолок, как раньше (иначе вернётся жалоба «не дослушивает»).
   * Порог мягче штатного completeThreshold (тишину провайдер уже подтвердил), но НЕ хардкод —
   * env-ручка как у остальных порогов эндпоинта (ревью Волны 2): JARVIS_STT_ENDPOINT_PCT, деф 60.
   */
  onProviderEndpoint(text?: string): EndpointDecision {
    const t = (text ?? this.lastText).trim();
    if (!t) return "wait";
    const threshold = envInt("JARVIS_STT_ENDPOINT_PCT", 60, 30, 95) / 100;
    const decision: EndpointDecision = this.detector.predictComplete(t) >= threshold ? "endpoint" : "wait";
    if (decision === "endpoint") this.reset();
    return decision;
  }

  reset(): void {
    this.lastText = "";
    this.silenceStartedAt = null;
  }
}
