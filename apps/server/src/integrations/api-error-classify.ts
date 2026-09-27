/**
 * Причина отказа API — чтобы НАЗВАТЬ её пользователю (вынесено из anthropic.ts, C3 аудита 27.09). Живой прогон
 * 2026-09-02: на исчерпанном балансе ключа человек слышал «Связь с сервером прервалась», хотя связь была в порядке.
 * Неверно названная причина — та же неправда, что ложное «Готово»: владелец пойдёт чинить сеть вместо баланса.
 */
export type ApiFailureKind = "credits" | "auth" | "region" | "rate_limit" | "overloaded" | "other";
export interface ApiFailure {
  kind: ApiFailureKind;
  /** Что сказать ВЛАДЕЛЬЦУ/пользователю голосом — коротко и по делу. */
  human: string;
  at: number;
}

/** Признаки того, что отказ — про КЛЮЧ/права (401 invalid x-api-key, 403 permission_error «API key does not…», OAuth). */
const KEY_MARKERS = /x-api-key|api.?key|authenticat|unauthorized|permission|oauth/i;

/**
 * Обёртка CLI подписки (адверс-ревью р1): без терминала claude.exe отдаёт ЛЮБОЙ 401/403 строкой
 * «Failed to authenticate. API Error: <status> <message>» — слово authenticate тут шаблон, а не признак ключа.
 * Снимаем только её (ТОЧКА и следом «API Error»); «Failed to authenticate: OAuth…» (двоеточие) — настоящая авторизация.
 */
const CLI_AUTH_WRAPPER = /Failed to authenticate\.\s*(?=API Error)/giu;

/** Статус из текста CLI («API Error: 401 …»), когда числового поля нет: 401 в обёртке — всегда не гео. */
function statusFromText(t: string): number | undefined {
  const m = /API Error:\s*(\d{3})\b/u.exec(t);
  return m ? Number(m[1]) : undefined;
}

/**
 * 🔴 C3 (аудит прод-логов 27.09): 403 `forbidden` «Request not allowed» приходил на КАЖДОМ входе в Windows —
 * VPN ещё не поднялся, запрос ушёл из сети, где API недоступен. Ключ исправен (позже на нём же приходил 400
 * credits), а классификатор по голому статусу 403 звал это «ключ не принят»: терминальный латч на 6 часов и
 * совет «поправить ANTHROPIC_API_KEY». Гео/сетевой блок — ТРАНЗИЕНТНЫЙ класс: лечится VPN, а не ключом.
 * Правило узкое: нужен маркер forbidden/«Request not allowed» и НИ ОДНОГО признака ключа.
 */
export function isRegionBlock(t: string, status: number | undefined): boolean {
  const code = status ?? statusFromText(t);
  if (code !== undefined && code !== 403) return false;
  const bare = t.replace(CLI_AUTH_WRAPPER, "");
  return /\bforbidden\b|request not allowed/i.test(bare) && !KEY_MARKERS.test(bare);
}

/** Классификация текста ошибки API (чистая функция — зеркало classifySubscriptionError). */
export function classifyApiError(text: string, status?: number): ApiFailure {
  const t = String(text ?? "");
  const at = Date.now();
  if (/credit balance is too low|insufficient.{0,20}credit|billing/i.test(t)) {
    return { kind: "credits", human: "у сервиса кончился баланс доступа к модели — я не смог к ней обратиться", at };
  }
  if (isRegionBlock(t, status)) {
    return { kind: "region", human: "сервис модели не пускает запрос из этой сети — проверьте VPN", at };
  }
  if (status === 401 || status === 403 || /invalid x-api-key|authentication|unauthorized|permission/i.test(t)) {
    return { kind: "auth", human: "ключ доступа к модели не принят — обращение не прошло", at };
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(t)) {
    return { kind: "rate_limit", human: "модель сейчас ограничивает частоту запросов — повторите через минуту", at };
  }
  if (status === 529 || /overloaded/i.test(t)) {
    return { kind: "overloaded", human: "модель сейчас перегружена — повторите чуть позже", at };
  }
  return { kind: "other", human: "связь с сервером прервалась", at };
}
