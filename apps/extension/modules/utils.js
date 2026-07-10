/**
 * Чистые утилиты SW-уровня (sleep + URL/host) — вынесено из god-file background.js (§ревью split).
 * Без состояния и без chrome-API side-effects; импортируются по значению, esbuild инлайнит в бандл.
 * Требуемых chrome-прав НЕТ (чистые функции). hostOf лечит «голый хост от LLM» (см. ниже).
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Хост без www. — для сравнения «та же вкладка сервиса». */
export function hostOf(u) {
  try {
    // КРИТИЧНО: LLM сплошь даёт ГОЛЫЙ хост («music.yandex.ru», «youtube.com/watch»). new URL без схемы
    // БРОСАЕТ → "" → findTargetTab уходил в активную вкладку (= Telegram). Подставляем схему.
    const s = /^[a-z]+:\/\//i.test(u) ? u : `https://${u}`;
    return new URL(s).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Путь+query URL (сравнение «та же страница или другая»). Голый/битый URL → "/". */
export function urlPathQuery(u) {
  try {
    const s = String(u);
    const x = new URL(s.includes("://") ? s : `https://${s}`);
    return (x.pathname || "/") + (x.search || "");
  } catch {
    return "/";
  }
}

/** Ошибка «целевой вкладки нет» — НЕ бьём в чужую активную (был баг: play/read уходили в Telegram). */
export function noTabError(url) {
  const host = hostOf(url);
  return new Error(host ? "вкладка " + host + " не открыта" : "нет подходящей вкладки");
}
