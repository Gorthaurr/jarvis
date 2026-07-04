/**
 * Контекстная ЭМОЦИЯ TTS (§11, §21) — провайдеро-независимая семантика эмоции и её отображение
 * на реальные возможности движков. Единый источник правды (DRY): и Yandex, и ElevenLabs берут
 * желаемую эмоцию отсюда, не дублируя карты.
 *
 * Семантическая эмоция (`Emotion`) задаётся выше по стеку (команда пользователя / LLM), а КАЖДЫЙ
 * провайдер сам решает, как её озвучить: Yandex — нативной ролью голоса (emotion-параметр v1),
 * ElevenLabs v3 — аудио-тегом. Несовместимые с голосом эмоции деградируют честно (см. resolveYandexRole).
 *
 * Каталог ролей Yandex — ЭМПИРИЧЕСКИ ПРОВЕРЕН живыми запросами (yandex-roles-probe.mjs, 2026-06-18):
 * параметр emotion в v1 реально меняет звук лишь у части голосов и лишь у части ролей; остальные
 * молча игнорируются ИЛИ дают HTTP 400 «Unknown role». Поэтому шлём роль ТОЛЬКО если голос её знает.
 */

/** Семантическая эмоция подачи (независимо от движка). */
export type Emotion = "neutral" | "happy" | "angry" | "strict" | "whisper";

export const EMOTIONS: readonly Emotion[] = ["neutral", "happy", "angry", "strict", "whisper"];

export function isEmotion(v: string | undefined): v is Emotion {
  return v !== undefined && (EMOTIONS as readonly string[]).includes(v);
}

/**
 * Какие роли Yandex РЕАЛЬНО влияют на звук у каждого голоса (проверено). Роли вне набора либо
 * игнорируются (filipp/madirus принимают молча), либо отвергаются 400 (jane/omazh/ermil/zahar) —
 * поэтому отправляем роль только из набора голоса, чтобы не ловить 400 и не «озвучивать впустую».
 */
const YANDEX_VOICE_ROLES: Record<string, readonly string[]> = {
  filipp: ["neutral", "strict"],
  ermil: ["neutral", "good"],
  zahar: ["neutral", "good"],
  madirus: ["neutral", "whisper"],
  jane: ["neutral", "good", "evil"],
  omazh: ["neutral", "evil"],
};

/** Семантическая эмоция → роли Yandex по приоритету (первая поддерживаемая голосом — выигрывает). */
const EMOTION_YANDEX_ROLES: Record<Emotion, readonly string[]> = {
  neutral: ["neutral"],
  happy: ["good"],
  angry: ["evil", "strict"], // настоящий гнев → evil; если голос не умеет — строгий (strict) как ближайшее
  strict: ["strict", "evil"],
  whisper: ["whisper"],
};

/**
 * Подобрать валидную роль Yandex под желаемую эмоцию для конкретного голоса.
 * undefined — голос эту эмоцию НЕ умеет (честный фолбэк: эмоцию не шлём, звучит нейтрально без 400).
 * Незнакомый голос → undefined (не рискуем неизвестной ролью → 400).
 */
export function resolveYandexRole(voice: string, emotion: Emotion): string | undefined {
  const supported = YANDEX_VOICE_ROLES[voice];
  if (!supported) return undefined;
  for (const role of EMOTION_YANDEX_ROLES[emotion]) {
    if (supported.includes(role)) return role;
  }
  return undefined;
}

/**
 * Итоговый emotion-параметр для тела запроса Yandex v1 (400-безопасный):
 *  - если задана желаемая эмоция — её роль (или undefined, если голос не умеет — не шлём);
 *  - иначе env-значение, но ТОЛЬКО если голос его поддерживает (иначе молчим, без 400).
 */
export function yandexEmotionParam(
  voice: string,
  desired: Emotion | undefined,
  envEmotion: string | undefined,
): string | undefined {
  if (desired) return resolveYandexRole(voice, desired);
  const env = (envEmotion ?? "").trim();
  if (!env) return undefined;
  const supported = YANDEX_VOICE_ROLES[voice];
  return !supported || supported.includes(env) ? env : undefined;
}

/** Какие семантические эмоции реально доступны голосу Yandex (диагностика/настройки). */
export function yandexEmotionsForVoice(voice: string): Emotion[] {
  return EMOTIONS.filter((e) => e === "neutral" || resolveYandexRole(voice, e) !== undefined);
}

/**
 * Аудио-тег ElevenLabs v3 под эмоцию (для НЕактивного сейчас ElevenLabs-пути; полнота абстракции).
 * neutral → без тега. v3 понимает естественные англ. теги в начале фразы.
 */
const EMOTION_V3_TAG: Record<Emotion, string> = {
  neutral: "",
  happy: "[happily]",
  angry: "[angry]",
  strict: "[sternly]",
  whisper: "[whispers]",
};

export function elevenV3Tag(emotion: Emotion): string {
  return EMOTION_V3_TAG[emotion];
}

/** Сдвиг stability ElevenLabs под силу эмоции: ярче эмоция → ниже stability (шире просодия). */
export function elevenStabilityFor(emotion: Emotion, base: number): number {
  if (emotion === "neutral") return base;
  return Math.min(base, 0.35); // эмоциональная подача требует более «творческой» (низкой) стабильности
}
