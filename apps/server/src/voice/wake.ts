/**
 * Текстовый wake word «Джарвис» (§3).
 *
 * Акустического движка нет (MockWakeWord), но речь распознаётся (Deepgram), поэтому будим по
 * тексту. ТРЕБОВАНИЕ: на обращение «Джарвис» реагировать БЕЗУСЛОВНО — Deepgram коверкает имя
 * («Жорвит», «Джаррис», «Жарвес», «Jarves»…), поэтому помимо явных вариантов матчим FUZZY:
 * любой токен в пределах малого расстояния редактирования от «джарвис»/«jarvis». Чистые функции.
 */

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

/** Убрать обращение «Джарвис» (с прилегающей пунктуацией), оставив команду. */
export function stripWake(text: string): string {
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
