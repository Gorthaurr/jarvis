/**
 * Текстовый wake word «Джарвис» (§3).
 *
 * Акустического движка нет (MockWakeWord), но речь распознаётся (Deepgram), поэтому будим по
 * тексту. ТРЕБОВАНИЕ: на обращение «Джарвис» реагировать БЕЗУСЛОВНО — Deepgram коверкает имя
 * («Жорвит», «Джаррис», «Жарвес», «Jarves»…), поэтому помимо явных вариантов матчим FUZZY:
 * любой токен в пределах малого расстояния редактирования от «джарвис»/«jarvis». Чистые функции.
 */
import { looksLikeCommandUtterance } from "../brain/agent/replay-gate.js";

/** Явные варианты, как STT слышит «Джарвис» (рус/лат) — быстрый путь. Границы — Unicode. */
const CORE =
  "(?:джарвис|джарвес|джарвиз|джарвиц|джарвиш|джарвич|джаррис|джарис|джервис|жарвис|жарвес|жарвиз|жарвиц|жаррис|жорвис|жорвит|жорвес|джорвис|ярвис|jarvis|jarves|jarvees|" +
  // Deepgram ЧАСТО роняет «дж»→«г» («Гарвис, вруби волну» — реальные пропуски из логов): добавляем
  // явные «г»-варианты, иначе prefix-гард отбрасывал их ДО fuzzy. + латинские ослышки из живых логов
  // («jarious», «jarvias», «jarvius», «jarry(s)», «jervis») — fuzzy ≤2 их не дотягивал (lev 3).
  // + лог-подтверждённые ослышки из РЕАЛЬНЫХ сессий (server.out.log): «Jares»/«Jarvey('s)»/«Jarvi('s)»/
  // «Jarvist» — fuzzy ≤2 не дотягивал «jares» (lev 3 до jarvis), а «-ey/-i» окончания мапим явно.
  "гарвис|гарвес|гарвиз|гарвиц|гарвиш|гаррис|jarry|jarrys|jervis|jarious|jarvias|jarvius|jarvees|jarvus|jares|jarvey|jarveys|jarvi|jarvist|jarvees)";
const WAKE_RE = new RegExp(`(?<![\\p{L}])(?:${CORE})(?![\\p{L}])`, "iu");
const WAKE_STRIP_RE = new RegExp(`[\\s,.!?:;—-]*(?<![\\p{L}])(?:${CORE})(?![\\p{L}])[\\s,.!?:;—-]*`, "iu");

/** Расстояние Левенштейна (O(n) память) — для fuzzy-матча ослышек имени. */
function levenshtein(a: string, b: string): number {
  const n = b.length;
  if (a.length === 0) return n;
  if (n === 0) return a.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] ?? 0;
}

/**
 * Похож ли токен на «Джарвис»: явный вариант ИЛИ fuzzy (≤2 правки до «джарвис»/«jarvis»).
 * Порог 2 ловит коверканья STT, но 7-буквенное «джарвис» в пределах 2 правок не совпадает с
 * обычными русскими словами (риск ложного будильника мал; окно разговора 20с дополнительно
 * ограничивает «встревания»). Латиница приведена к нижнему регистру.
 */
function looksLikeWake(token: string): boolean {
  const t = token.toLowerCase();
  if (t.length < 4 || t.length > 11) return false;
  if (WAKE_RE.test(t)) return true;
  // Начинается похоже (дж/ж/я/j/г) — иначе не считаем, чтобы не ловить случайное слово той же длины.
  // «г» добавлен: Deepgram роняет «дж»→«г» (Гарвис/Гарвиз), lev≤2 до «джарвис» это ловит.
  if (!/^(?:дж|ж|я|j|г)/u.test(t)) return false;
  return levenshtein(t, "джарвис") <= 2 || levenshtein(t, "jarvis") <= 2;
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/** Есть ли в реплике обращение «Джарвис» (явное или коверканное). */
export function isWakeAddressed(text: string): boolean {
  if (WAKE_RE.test(text)) return true;
  const tokens = text.match(TOKEN_RE);
  if (!tokens) return false;
  return tokens.some(looksLikeWake);
}

/**
 * Near-miss ПЕРВОГО токена до «джарвис»/«jarvis» (Б5, форензика 2026-07-10): «Дарья, запусти поиск
 * в доте» (lev 4) молча тонула в игноре — оба слоя матчера бессильны, а дроп был неотличим от трёпа.
 * Обращение обычно первым словом → меряем только его. 99 = заведомо не обращение (короткий/длинный
 * токен, пусто). Диагностика (в лог игнора) + вход second-chance («Вы мне, сэр?») — НЕ пробуждение.
 */
export function wakeNearMissScore(text: string): number {
  const tokens = text.match(TOKEN_RE);
  const t = (tokens?.[0] ?? "").toLowerCase();
  if (t.length < 4 || t.length > 11) return 99;
  return Math.min(levenshtein(t, "джарвис"), levenshtein(t, "jarvis"));
}

/** Словарь подтверждений «Вы мне, сэр?» — узкий, чтобы трёп («да, объективно») не проходил. */
const SECOND_CHANCE_VOCAB = new Set(["да", "ага", "угу", "конечно", "тебе", "мне", "вам", "говорю"]);

/**
 * Подтверждение second-chance (Б5, ревью 2026-07-10): ≤2 токенов и ВСЕ из словаря подтверждений
 * («да», «тебе», «да, тебе»). Ревью показало: открывать окно разговора на near-miss НЕЛЬЗЯ («давай»
 * lev 4 — любая следующая фраза трёпа уходила бы командой); принимаем только явное короткое «да».
 */
export function isSecondChanceConfirm(text: string): boolean {
  const tokens = text.match(TOKEN_RE);
  if (!tokens || tokens.length === 0 || tokens.length > 2) return false;
  return tokens.every((t) => SECOND_CHANCE_VOCAB.has(t.toLowerCase()));
}

/** Срезать первый токен (псевдо-имя «Дарья»/«Гуляю») с пунктуацией — остаток = исходная команда. */
export function stripLeadingToken(text: string): string {
  return text.replace(/^[\s,.!?:;—-]*[\p{L}\p{N}]+[\s,.!?:;—-]*/u, "").trim();
}

/**
 * Чистые междометия/филлеры, на которые Джарвис НЕ должен встревать (§3). Это не команды и не
 * ответы — короткие выдохи/хмыки, что Deepgram ловит из фонового шума («ах», «ох», «хм»…).
 * НЕ включаем «да/нет/ок/угу/ага/ладно» — это валидные ответы в активном разговоре (нельзя глушить).
 */
const NOISE_WORDS = new Set([
  "ах", "ох", "ой", "эх", "эй", "ау", "ну", "э", "эм", "эмм", "мм", "ммм",
  "хм", "хмм", "гм", "кхм", "ааа", "ооо", "эээ", "а", "о", "у", "и", "ы", "м", "н",
]);

/**
 * Реплика — это ОДНО шумовое междометие (или два подряд), без смысловой нагрузки? Тогда в окне
 * продолжения разговора её игнорируем (реагируем только на обращение «Джарвис» или настоящую
 * фразу). Длинные реплики (>2 токенов) — всегда содержательны, шумом не считаются.
 */
export function isNoiseOnly(text: string): boolean {
  const tokens = text.toLowerCase().match(TOKEN_RE);
  if (!tokens || tokens.length === 0) return true; // пустое/только пунктуация — шум
  if (tokens.length > 2) return false;
  return tokens.every((tok) => NOISE_WORDS.has(tok));
}

/**
 * Хвост после обращения, который командой НЕ является: «Открой ютуб, Джарвис, пожалуйста» — команда
 * ДО обращения, «пожалуйста» после него — вежливость. Такой хвост трактуется как пустой.
 */
const COURTESY_TAIL = new Set(["пожалуйста", "спасибо", "плиз", "please", "давай", "быстро", "быстрее", "срочно", "уже"]);

function isCourtesyOnly(text: string): boolean {
  const tokens = text.toLowerCase().match(TOKEN_RE);
  if (!tokens || tokens.length === 0) return true;
  return tokens.every((t) => COURTESY_TAIL.has(t) || NOISE_WORDS.has(t));
}

/**
 * Разрезать реплику по ПЕРВОМУ обращению (ревью 2026-09-24, B-F12). Пре-ролл локального wake (1,5 с до
 * «Джарвис») и сегментация STT тащат в реплику звук ДО обращения — обрывок ТВ/чужой речи. Приклеенный к
 * команде, он её ломает: «…что Джарвис, открой ютуб» уходило роутеру как «что открой ютуб» — вопрос, а
 * не действие. null — обращения нет.
 */
export function splitAtWake(text: string): { before: string; after: string } | null {
  for (const m of text.matchAll(TOKEN_RE)) {
    if (!looksLikeWake(m[0])) continue;
    const at = m.index ?? 0;
    return { before: text.slice(0, at), after: text.slice(at + m[0].length) };
  }
  return null;
}

/**
 * Контроль-1 №3 (ревью 2026-09-24): что стоит ДО «Джарвис» в той же фразе — обрывок пре-ролла или смысл команды?
 * Первая версия B-F12 сохраняла префикс только с командным глаголом и теряла адресата/время/программу:
 * «Кате, Джарвис, напиши…» уходило «напиши…» без Кати, «Завтра в девять, Джарвис, напомни…» — без времени.
 * Обрывок пре-ролла (0,9 с) — это служебные слова («…что», «так вот», «бла бла»); смысл — хоть одно содержательное
 * слово в короткой (≤ PREFIX_MAX_WORDS) группе. Длиннее — уже не префикс команды, а чужая речь.
 */
const PREFIX_FUNCTION_WORDS = new Set([
  ...NOISE_WORDS,
  "что", "чтобы", "так", "вот", "это", "то", "как", "но", "да", "нет", "ага", "угу", "он", "она", "оно", "они", "мы",
  "вы", "ты", "я", "бла", "короче", "значит", "типа", "вообще", "просто", "сказал", "сказала", "говорит", "говорю",
  "слушай", "смотри", "окей", "ладно", "же", "ли", "бы", "вон", "там", "тут", "его", "её", "их", "ещё", "уже",
]);
const PREFIX_MAX_WORDS = 4;
function meaningfulPrefix(before: string): boolean {
  const words = before.toLowerCase().match(TOKEN_RE) ?? [];
  return words.length > 0 && words.length <= PREFIX_MAX_WORDS && words.some((w) => !PREFIX_FUNCTION_WORDS.has(w));
}

/** Срезать разделители на стыке с обращением. Концевые «?»/«!»/«.» НЕ трогаем: «?» — признак вопроса для роутера. */
const cleanAfter = (s: string): string => s.replace(/^[\s,.!?:;—-]+/u, "").replace(/\s+/gu, " ").trim();
const cleanBefore = (s: string): string => s.replace(/^[\s,.!?:;—-]+/u, "").replace(/[\s,:;—-]+$/u, "").replace(/\s+/gu, " ").trim();

/**
 * Убрать обращение «Джарвис», оставив команду. Команда — то, что ПОСЛЕ обращения (B-F12: текст до него —
 * это обрывок, попавший в пре-ролл); если после обращения ничего содержательного нет («открой блокнот,
 * джарвис», «…, Джарвис, пожалуйста») — команда стоит ДО обращения.
 * Обращение-ВСТАВКА посреди своей же команды («Поставь напоминание, Джарвис, на пять») начало не теряет:
 * префикс в той же фразе (не отделён точкой/?/!) и сам похож на команду (глагол-действие) → это одна реплика
 * владельца. Обрывок фона («…что», «…Путина.») — отбрасывается.
 */
export function stripWake(text: string): string {
  return stripWakeDetailed(text).command;
}

/** То же, что stripWake, плюс отброшенный текст ДО обращения — пайплайн пишет его в лог (разбор «съел начало»). */
export function stripWakeDetailed(text: string): { command: string; droppedPrefix?: string } {
  const parts = splitAtWake(text);
  if (parts) {
    const after = cleanAfter(parts.after);
    const before = cleanBefore(parts.before);
    if (after && !isCourtesyOnly(after)) {
      if (!before) return { command: after };
      const sameSentence = !/[.!?…]\s*$/u.test(parts.before);
      if (sameSentence && (looksLikeCommandUtterance(before) || meaningfulPrefix(before))) return { command: `${before} ${after}` };
      return { command: after, droppedPrefix: before };
    }
    return { command: before };
  }
  return { command: stripWakeLegacy(text) };
}

/** Прежний путь — только если токена-обращения не нашлось (страховка: isWakeAddressed мог сработать по WAKE_RE). */
function stripWakeLegacy(text: string): string {
  let out = text.replace(WAKE_STRIP_RE, " ");
  // Fuzzy-ослышка («Джаррис, …») не попала в явный regex — срежем такой токен, оставив остальное.
  if (out === text) {
    out = text
      .split(/(\s+)/u)
      .filter((part) => !looksLikeWake(part.replace(/[^\p{L}\p{N}]/gu, "")))
      .join("");
  }
  return out.replace(/^[\s,.!?:;—-]+/u, "").replace(/\s+/gu, " ").trim();
}
