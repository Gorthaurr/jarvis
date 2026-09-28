/**
 * Проверки связи и время — мгновенно, БЕЗ модели (28.09, жалоба владельца «медленно»).
 *
 * По логам «Джарвис, ты меня слышишь?» шёл в Opus: 3,9–5,7 с на ответ «Слышу, сэр» (initMs ~1 с + TTFT ~3 с при
 * контексте 68–80K токенов), «Джарвис.» и «Прием.» заводили фоновую sonnet-ЗАДАЧУ, которую владелец отменял руками.
 * Такие реплики — ЗАКРЫТЫЙ список точных форм (позитивный allowlist: блоклист тут принципиально неполон); всё, что
 * не совпало ЦЕЛИКОМ, идёт прежним путём. Ответ — фиксированные слова дворецкого, время — часы сервера (машина владельца).
 */
import { stripWakeAndFiller } from "../router/index.js";
import { verbalize } from "../verbalize/index.js";

export type PresenceKind = "listening" | "hear" | "here" | "radio" | "time";

const WAKE_RE = /(?<![\p{L}])(?:джарвис|джарвиз|джарис|жарвис)/iu;
const HEAR_RE = /^(?:ты\s+)?(?:меня\s+)?(?:слышишь|слышите|слышно)(?:\s+(?:меня|ты|там))*$|^как\s+слышно$/u;
// «тут/здесь/там» голыми — ответ на вопрос модели («на этом экране или на втором?» → «давай здесь»), не проверка связи: нужно «ты …».
const HERE_RE = /^(?:ты\s+(?:тут|здесь|там|живой|со\s+мной)|(?:ты\s+)?на\s+связи)(?:\s+(?:ещ[её]|там))?$/u;
// «С приёмом» — частая STT-ослышка «приём»; «Джарвис, приём» — радио-проверка связи.
const RADIO_RE = /^(?:с\s+)?(?:приём|приема|приемом|приёмом|прием)(?:\s+(?:приём|прием))?$/u;
const TIME_RE = /^(?:сколько\s+(?:сейчас\s+)?времени|который\s+(?:сейчас\s+)?час|сколько\s+(?:сейчас\s+)?на\s+часах|скажи\s+(?:который\s+час|сколько\s+времени))$/u;

const tidy = (s: string): string =>
  s.toLowerCase().replace(/[.!?…,]+$/gu, "").replace(/\s+/gu, " ").trim();

/** Реплика — ровно проверка связи/время? (после снятия обращения и вежливости). null — идти прежним путём. */
export function matchPresence(clean: string): PresenceKind | null {
  const raw = clean.trim();
  if (!raw) return null;
  const t = tidy(stripWakeAndFiller(raw));
  if (t === "") {
    if (/слыш(?:ишь|ите|но)/iu.test(raw)) return "hear"; // «Джарвис, слышишь?» — «слышишь» снято как филлер обращения
    if (/привет|здравств|добр(?:ое|ый|ого)|хай|салют/iu.test(raw)) return null; // «Джарвис, привет» — приветствие, не «Слушаю»
    return WAKE_RE.test(raw) ? "listening" : null; // голое «Джарвис.» — не «привет»/«давай» без обращения
  }
  if (HEAR_RE.test(t)) return "hear";
  if (HERE_RE.test(t)) return "here";
  if (RADIO_RE.test(t)) return "radio";
  if (TIME_RE.test(t)) return "time";
  return null;
}

export function presenceVoice(kind: PresenceKind, now: Date = new Date()): string {
  switch (kind) {
    case "listening":
      return "Слушаю, сэр.";
    case "hear":
      return "Слышу, сэр.";
    case "here":
      return "Тут, сэр.";
    case "radio":
      return "На связи, сэр.";
    case "time": {
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      return verbalize(`Сейчас ${hh}:${mm}, сэр.`);
    }
  }
}
