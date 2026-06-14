/**
 * Детерминированный RU-классификатор команд управления задачей (§20).
 *
 * Ключевое различие §20, ради которого и нужен этот классификатор:
 *   «стоп»/«заткнись»/«тихо»/«помолчи»/«замолчи»/«хватит говорить» рубят
 *      ТОЛЬКО озвучку (TTS) → kind "stop_tts"; сама задача продолжается.
 *   «отмени»/«отставить»/«прекрати задачу»/«брось»/«забудь про это»/«не надо
 *      больше» рубят САМУ задачу → kind "cancel".
 * Их нельзя путать: первый случай оставляет работу идти, второй — обрывает её.
 *
 * Реализация — чистая функция от текста реплики (детерминизм, без состояния и
 * зависимостей). Вход нормализуется (toLowerCase, trim, снятие пунктуации,
 * схлопывание пробелов), сопоставление идёт по словам/фразам с явными границами
 * (кириллица: НЕ полагаемся на \b, который для русских букв ненадёжен — границы
 * задаём пробелами/началом/концом нормализованной строки).
 *
 * Уверенность:
 *   "high" — однозначное совпадение (ключевое слово/фраза без конфликтующих
 *            сигналов; либо пустой/обычный текст → none).
 *   "low"  — пограничный/частичный случай (напр. «стоп» рядом со словом про
 *            задачу, или «хватит» без «говорить»). Вызывающий код (agent-loop)
 *            ЭСКАЛИРУЕТ такие реплики на Haiku-классификатор для уточнения, а не
 *            действует вслепую (§20).
 */
import type { TaskControlKind } from "./task.js";

/** Решение классификатора управления задачей (§20). */
export interface TaskControlDecision {
  /** Род команды управления (§20): cancel/stop_tts/pause/resume/status/none. */
  kind: TaskControlKind;
  /** Уверенность: "high" — однозначно; "low" — эскалировать на Haiku (§20). */
  confidence: "high" | "low";
  /** Человекочитаемая причина решения (для логов/отладки §22 и эскалации). */
  reason: string;
}

/**
 * Нормализация входа: нижний регистр, снятие пунктуации (кроме внутренних
 * дефисов как пробелов), схлопывание пробелов, ё→е для устойчивости совпадений.
 * Возвращает строку с ведущим/замыкающим пробелом — так каждое слово окружено
 * пробелами и проверка границ через " слово " работает и для кириллицы.
 */
function normalize(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/ё/g, "е")
    // всё, что не буква/цифра — в пробел (кириллица + латиница + цифры).
    .replace(/[^a-z0-9а-я]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? ` ${cleaned} ` : "";
}

/** Есть ли слово (целиком, по границам) в нормализованной строке с пробелами. */
function hasWord(norm: string, word: string): boolean {
  return norm.includes(` ${word} `);
}

/** Есть ли фраза (как подстрока) в нормализованной строке. */
function hasPhrase(norm: string, phrase: string): boolean {
  return norm.includes(phrase);
}

/** Есть ли в строке слово с одной из приставок-основ (для словоформ). */
function hasStem(norm: string, stems: readonly string[]): boolean {
  return stems.some((stem) => norm.includes(` ${stem}`));
}

/** Основы слов «задача/работа/дело» — сигнал, что речь про САМУ задачу (cancel). */
const TASK_STEMS = ["задач", "работ", "дел", "это", "этим", "больше"] as const;

/** stop_tts: оборвать ТОЛЬКО озвучку, задача живёт (§20). */
const STOP_TTS_WORDS = ["стоп", "стой", "заткнись", "тихо", "тише", "помолчи", "замолчи"] as const;
/** stop_tts фразы. */
const STOP_TTS_PHRASES = ["хватит говорить", "перестань говорить", "не говори", "не болтай"] as const;

/** cancel: прервать САМУ задачу (§20). */
const CANCEL_WORDS = ["отмени", "отмена", "отменить", "отставить", "прекрати", "прекратить", "прерви", "прервать", "брось", "бросить", "забудь", "забей"] as const;
/** cancel фразы. */
const CANCEL_PHRASES = ["забудь про это", "забудь об этом", "не надо больше", "больше не надо", "отмени задачу", "прекрати задачу"] as const;

/** pause: приостановить с возможностью resume (§20). */
const PAUSE_WORDS = ["пауза", "приостанови", "приостановить", "отложи", "отложить"] as const;
/** pause фразы. */
const PAUSE_PHRASES = ["потом доделаешь", "потом доделай", "погоди с этим", "на паузу", "сделай паузу", "пока отложи"] as const;

/** resume: возобновить с текущего шага (§20). */
const RESUME_WORDS = ["продолжи", "продолжай", "продолжить", "дальше", "доделай", "доделаешь", "возобнови", "возобновить"] as const;

/** status: отчёт о текущем прогрессе (§20). */
const STATUS_WORDS = ["докладывай", "доложи", "готово"] as const;
/** status фразы. */
const STATUS_PHRASES = ["что делаешь", "что ты делаешь", "как там", "как дела с задачей", "на чем ты", "что по задаче", "чем занят", "чем занимаешься", "как продвигается", "как успехи"] as const;

/**
 * Классификатор команды управления задачей (§20). Чистая функция.
 *
 * Алгоритм:
 *  1) Пустой/обычный текст → none/high.
 *  2) Точные фразы (длиннее, специфичнее) проверяются раньше одиночных слов.
 *  3) stop_tts vs cancel — главное различие §20. «стоп» сам по себе → stop_tts/high;
 *     но «стоп» рядом со словом про задачу («стоп, отмени задачу» уже поймает cancel;
 *     «стоп задачу» — двусмысленно) → low с пояснением для эскалации на Haiku.
 *  4) «хватит» без «говорить» — двусмысленно (озвучка? задача?) → low.
 */
export function classifyTaskControl(text: string): TaskControlDecision {
  const norm = normalize(text);
  if (norm === "") {
    return { kind: "none", confidence: "high", reason: "пустой/пробельный ввод" };
  }

  const aboutTask = hasStem(norm, TASK_STEMS);

  // 2a) Однозначные cancel-фразы (специфичнее одиночных слов) — проверяем первыми.
  for (const phrase of CANCEL_PHRASES) {
    if (hasPhrase(norm, ` ${phrase} `) || hasPhrase(norm, `${phrase} `) || norm.includes(` ${phrase}`)) {
      return { kind: "cancel", confidence: "high", reason: `cancel-фраза «${phrase}» — прервать задачу (§20)` };
    }
  }

  // 2b) Однозначные stop_tts-фразы.
  for (const phrase of STOP_TTS_PHRASES) {
    if (norm.includes(` ${phrase}`) || norm.includes(`${phrase} `)) {
      return { kind: "stop_tts", confidence: "high", reason: `stop_tts-фраза «${phrase}» — оборвать только озвучку (§20)` };
    }
  }

  // 2c) Однозначные pause-фразы.
  for (const phrase of PAUSE_PHRASES) {
    if (norm.includes(` ${phrase}`) || norm.includes(`${phrase} `)) {
      return { kind: "pause", confidence: "high", reason: `pause-фраза «${phrase}» — приостановить задачу (§20)` };
    }
  }

  // 2d) Однозначные status-фразы.
  for (const phrase of STATUS_PHRASES) {
    if (norm.includes(` ${phrase}`) || norm.includes(`${phrase} `)) {
      return { kind: "status", confidence: "high", reason: `status-фраза «${phrase}» — отчёт о прогрессе (§20)` };
    }
  }

  // 3) cancel-слова: отмени/отставить/прекрати/брось/забудь.
  const cancelWord = CANCEL_WORDS.find((w) => hasWord(norm, w));
  if (cancelWord) {
    return { kind: "cancel", confidence: "high", reason: `cancel-слово «${cancelWord}» — прервать задачу (§20)` };
  }

  // 4) stop_tts-слова: стоп/стой/заткнись/тихо/помолчи/замолчи.
  const stopWord = STOP_TTS_WORDS.find((w) => hasWord(norm, w));
  if (stopWord) {
    // «стоп» рядом со словом про задачу — двусмысленно (TTS или задача?) → low.
    if (aboutTask) {
      return {
        kind: "stop_tts",
        confidence: "low",
        reason: `«${stopWord}» рядом со словом про задачу — возможно cancel, эскалировать на Haiku (§20)`,
      };
    }
    return { kind: "stop_tts", confidence: "high", reason: `stop_tts-слово «${stopWord}» — оборвать только озвучку (§20)` };
  }

  // 5) pause-слова.
  const pauseWord = PAUSE_WORDS.find((w) => hasWord(norm, w));
  if (pauseWord) {
    return { kind: "pause", confidence: "high", reason: `pause-слово «${pauseWord}» — приостановить задачу (§20)` };
  }

  // 6) resume-слова.
  const resumeWord = RESUME_WORDS.find((w) => hasWord(norm, w));
  if (resumeWord) {
    return { kind: "resume", confidence: "high", reason: `resume-слово «${resumeWord}» — возобновить задачу (§20)` };
  }

  // 7) status-слова.
  const statusWord = STATUS_WORDS.find((w) => hasWord(norm, w));
  if (statusWord) {
    return { kind: "status", confidence: "high", reason: `status-слово «${statusWord}» — отчёт о прогрессе (§20)` };
  }

  // 8) «хватит» без «говорить»/«задачу» — двусмысленно (озвучка или задача?) → low.
  if (hasWord(norm, "хватит") || hasWord(norm, "перестань")) {
    return {
      kind: "stop_tts",
      confidence: "low",
      reason: "«хватит/перестань» без уточнения (говорить?/задачу?) — эскалировать на Haiku (§20)",
    };
  }

  // 9) Ничего не сработало — обычная реплика/контент.
  return { kind: "none", confidence: "high", reason: "не команда управления — обычная реплика" };
}
