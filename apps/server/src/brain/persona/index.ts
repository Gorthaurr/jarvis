/**
 * Сборка системного промпта (§11, §15).
 *
 * Статичный префикс (персона из persona.md) кешируется и не меняется между
 * запросами — это включает prompt caching на стороне Anthropic (§15): кешируемый
 * блок идёт первым, динамика пользователя — отдельным хвостом.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, createLogger } from "@jarvis/shared";
import { compactLocalPersona } from "./compact-local.js";
import { renderDynamic } from "./dynamic-context.js";

const log: Logger = createLogger("persona");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONA_PATH = join(__dirname, "persona.md");

/** Кеш статичного префикса — читаем persona.md один раз на процесс. */
let cachedPersona: string | null = null;

/** Прочитать персону с диска (с фоллбэком, если файл не найден). */
function loadPersona(): string {
  if (cachedPersona !== null) return cachedPersona;
  try {
    cachedPersona = readFileSync(PERSONA_PATH, "utf8");
  } catch (e) {
    // НЕ кешируем фоллбэк: транзиентный сбой чтения (антивирус/лок файла при деплое на Windows)
    // иначе НАВСЕГДА залип бы на 3-строчной персоне. Возвращаем фоллбэк, но cachedPersona=null →
    // следующий вызов повторит чтение настоящего файла.
    log.warn("persona.md не прочитан — временный фоллбэк, повторю чтение", {
      error: e instanceof Error ? e.message : String(e),
    });
    return FALLBACK_PERSONA;
  }
  return cachedPersona;
}

/** Динамический контекст пользователя — подставляется в хвост промпта (§15). */
export interface UserContextSlot {
  /** Имя/обращение, как звать пользователя. */
  displayName?: string;
  /** Часовой пояс (для времени в ответах). */
  timezone?: string;
  /** КУРИРУЕМЫЕ факты долговременной памяти (§8) — asserted (профиль, высокая уверенность). */
  facts?: readonly string[];
  /**
   * Эпизодический recall (§8) — НЕподтверждённые записи, всплывшие из прошлых разговоров, ОТДЕЛЬНО от
   * курируемых `facts` (аудит контекста 2026-07-20). Идут ХЕДЖИРОВАННЫМ блоком «возможно… сверься»:
   * низкоуверенный/устаревший сосед на шумном e5-small не должен читаться моделью как твёрдый факт.
   */
  recalledMemories?: readonly string[];
  /** Авто-профиль окружения (§9): браузер/приложения пользователя — чтобы агент адаптировался. */
  environment?: string;
  /**
   * Живой системный снимок (§контекст): что СЕЙЧАС открыто/на переднем плане + мониторы. В отличие
   * от статичного environment — обновляется периодически (client.system). Идёт в НЕкешируемый хвост.
   */
  systemContext?: string;
  /** Свободный контекст о пользователе из настроек (стиль, привычки, как обращаться). */
  context?: string;
  /** Язык общения из настроек ("ru"/"en") — на каком языке отвечать. */
  language?: string;
  /**
   * Подобранный recall'ом выученный навык-процедура (§8 HERMES): готовый блок текста
   * «когда применять + шаги + грабли + проверка» от прошлого успешного решения похожей
   * задачи. Вшивается в системный промпт — LLM ему СЛЕДУЕТ (гибко), не реплеит.
   */
  learnedSkill?: string;
  /** Оверлей тона активного режима-маски (§11): доп. инструкция подачи. Пусто у дворецкого. */
  personaTone?: string;
  /**
   * §20: готовый блок «недавно выполненные задачи» (formatRecentTasks) — чтобы Джарвис ОСОЗНАННО
   * отвечал на «сделал?»/«что делал?» из долговечного реестра задач, а не из вытесняемого окна реплик.
   * Идёт в НЕкешируемый динамический хвост (меняется каждый ход) → prompt-кеш §15 не страдает.
   */
  recentTasks?: string;
  /**
   * §8 Фаза 3: компактный каталог ВЫУЧЕННЫХ навыков (имя+когда), показывается ТОЛЬКО при лексическом
   * промахе recall — чтобы Claude сам применил подходящий ПО СМЫСЛУ (падежи/синонимы/Герман↔Herman).
   * Некешируемый хвост. Эмбеддинги не нужны (у Claude их нет) — семантику делает сама модель.
   */
  skillCatalog?: string;
  /**
   * Волна E: паспорт возможностей (brain/capabilities.ts) — живой снимок «что доступно СЕЙЧАС»
   * (расширение подключено? MCP поднялись? ключи заданы? killswitch?). Честность ДО провала: модель
   * не обещает мёртвый канал, а сразу называет, как его включить. НЕкешируемый хвост, капнут (~900).
   * Это НАШ статус (не влияемые атакующим данные) — идёт доверенным текстом, без untrusted-обёртки.
   */
  capabilities?: string;
  /**
   * §режим выделения (2026-09-03): владелец обвёл рамкой кусок экрана и говорит о нём дейксисом
   * («вот тут недочёт»). Строка — НАШ статус (факт указания, размер, монитор, возраст), не содержимое
   * области: что там нарисовано, добывается инструментом. Некешируемый хвост, как capabilities.
   */
  selection?: string;
}

/**
 * Собрать системный промпт: [кешируемая персона] + [динамика пользователя].
 * Возвращает блоки раздельно, чтобы слой LLM-клиента мог пометить первый как
 * cache_control (§15). Для простоты M0 — также склеенная строка `full`.
 */
/**
 * LEAN-ядро персоны для ТРИВИАЛЬНЫХ разговорных ходов (smalltalk/приветствие, §econ 2026-07-21). Полная
 * персона (~33К) на «привет» = холодная запись кеша ~$0.2/ход (лог-анализ: 27 таких ходов = 11% трат —
 * тир-свитч haiku↔sonnet фрагментирует префикс). Здесь — ТОЛЬКО жёсткие правила, важные для устной
 * социальной реплики: русский-всегда, идентичность Джарвиса, тон дворецкого, кириллица иностранных,
 * честность. Инструментов/законов verify-петли/каталога возможностей НЕТ — «привет» их не требует.
 * За флагом (агент гейтит `JARVIS_LEAN_SMALLTALK`); полная персона — дефолт (нулевой регресс).
 */
export const LEAN_PERSONA_CORE = `# Jarvis — lean (лёгкая разговорная реплика)
You are Jarvis, a personal voice assistant-majordomo for ONE user (his Windows PC). This turn is a LIGHT
social/conversational reply (greeting, thanks, small-talk, «как дела») — answer WARMLY and BRIEFLY, in character.
Hard rules (never break, even here):
- **OUTPUT IS ALWAYS RUSSIAN** — every reply in Russian, no exceptions, even for a single word or unclear input.
- **You are Jarvis, only Jarvis.** Asked who you are → «Джарвис, ваш ассистент». NEVER discuss your internals
  (models/providers/tokens/gateways). Something failed → say it humanly («не получилось», «связь прервалась»), no tech detail.
- **Tone:** calm butler; address «сэр» (or no address); short natural spoken Russian; no markdown/emoji/URLs in speech.
- **Foreign words → CYRILLIC by sound** in the reply (voice engine mangles Latin): «YouTube»→«ютьюб», «VPN»→«ви-пи-эн», «Chrome»→«хром».
- **Honesty:** NEVER claim you did something you didn't — this is a light social turn, not an action. If the user
  actually asks for a concrete action (open/send/set/play…), do NOT fake a result and do NOT promise a "later" — just
  answer honestly and briefly (say you'll take care of it now, without pretending it's already done).
Keep it to one or two short sentences.`;

export function buildSystemPrompt(
  slot: UserContextSlot = {},
  opts: { lean?: boolean; local?: boolean } = {},
): {
  staticPrefix: string;
  /** §8 HERMES: блок выученного навыка — ОТДЕЛЬНО от динамики, чтобы кешировать его собственным
   *  брейкпоинтом (повторные ходы той же задачи читают навык из кеша, а не шлют заново). */
  skillSuffix: string;
  dynamicSuffix: string;
  full: string;
} {
  // LEAN (smalltalk): короткое ядро вместо полной персоны + УРЕЗАННАЯ динамика (имя/время/тон/язык —
  // без live-снимка ПК/фактов/recall/каталога навыков: «привет» их не требует, а это лишние 1x-токены).
  const lean = opts.lean === true && opts.local !== true;
  const staticPrefix = lean ? LEAN_PERSONA_CORE : opts.local ? compactLocalPersona(loadPersona()) : loadPersona();
  const dynSlot: UserContextSlot = lean
    ? { timezone: slot.timezone, displayName: slot.displayName, personaTone: slot.personaTone, language: slot.language }
    : slot;
  const skillSuffix = !lean && slot.learnedSkill ? `# Подходящий выученный навык (§8)\n\n${slot.learnedSkill}` : "";
  const dynamicSuffix = renderDynamic(dynSlot);
  return {
    staticPrefix,
    skillSuffix,
    dynamicSuffix,
    full: [staticPrefix, skillSuffix, dynamicSuffix].filter(Boolean).join("\n\n"),
  };
}

const FALLBACK_PERSONA = [
  "Ты — Джарвис, лаконичный голосовой ассистент. Говоришь по-русски.",
  "Кратко, по делу, без подхалимства. Юмор сухой и только в безобидных темах —",
  "никогда в ошибках, деньгах и подтверждениях. Неуверенность называешь прямо.",
].join(" ");
