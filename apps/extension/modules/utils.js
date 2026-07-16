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

/**
 * Приватный/локальный/link-local хост (SSRF-класс). allFrames-чтение (read/inspect) инжектит скрипт
 * в КАЖДЫЙ фрейм на привилегии расширения (обходит SOP) — фрейм с `src` на роутер/intranet/метаданные
 * иначе слил бы своё содержимое в контекст модели. Зеркалит серверный browserUrlBlocked (там URL,
 * который просят ОТКРЫТЬ; тут — реальные URL встроенных фреймов, которые сервер не видит). Пусто/битый
 * хост (about:blank, data:, sandbox) — приватным НЕ считаем: там нет сети для эксфильтрации.
 */
export function isPrivateHost(u) {
  // hostname (НЕ host): без порта и без [] у IPv6 — иначе «127.0.0.1:8080»/«[::1]» не матчили IP-регексп.
  let host = "";
  try {
    const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
    host = new URL(s).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv6-литерал (только если host РЕАЛЬНО IPv6 — содержит ':'; иначе публичные домены fcbarcelona.com/
  // fdj.fr ложно попадали в fc/fd unique-local, ревью #1). loopback/unique-local(fc/fd)/link-local(fe80).
  if (host.includes(":")) {
    return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private-A / this-host
  if (a === 192 && b === 168) return true; // private-C
  if (a === 169 && b === 254) return true; // link-local (вкл. 169.254.169.254 — облачные метаданные)
  if (a === 172 && b >= 16 && b <= 31) return true; // private-B
  return false;
}
