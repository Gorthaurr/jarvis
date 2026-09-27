/**
 * B-14 (DNS): суд над адресом НАВИГАЦИИ браузера по ответу DNS — до отправки клиенту/расширению. browserUrlBlocked
 * судит имя из URL, и `localtest.me` / `127.0.0.1.nip.io` (→ 127.0.0.1) он пропускал: невидимый Chrome Джарвиса
 * реально сходил на dev-HTTP сервера (живой факт 27.09). Здесь: приватен любой адрес ответа → честный отказ.
 *
 * «Не разрешилось» (NXDOMAIN) — ПРОПУСКАЕМ: сервер сам не подключается, резолвит браузер; невидимый браузер судит каждый
 * Document-запрос сам (NavGuard, там «не разрешилось» = отказ). Но DNS, МОЛЧАЩИЙ дольше таймаута, — ОТКАЗ (адверс-ревью):
 * Chrome ждёт ответа дольше нас, и NS атакующего с задержкой 4 с отдал бы ему 127.0.0.1 мимо суда. Rebinding
 * (второй резолв браузера ответит иначе) этот слой не закрывает — см. docs/SECURITY.md «SSRF по DNS».
 *
 * Порядок в dispatch: суд — ДО §14-вопроса и ДО памяти цели web_act (rememberWebTarget). Раньше память стояла выше
 * гарда, и отклонённый URL становился «последней целью» web_act.
 */
import { type HostLookup, checkHostPublic, limitLookup, systemLookup, urlHostname } from "@jarvis/shared";
import type { ToolResult } from "./dispatch.js";
import { browserUrlBlocked, err } from "./dispatch-util.js";

/** Резолвер по умолчанию: системный через лимитер+кеш (каждый browser_read судит адрес вкладки). Тесты подменяют
 *  глобалом `__jarvisTestNavLookup` (vitest.setup) — иначе набор ходил бы в живой DNS и висел при его сбое. */
const serverLookup = limitLookup(systemLookup);
const defaultLookup = (): HostLookup => (globalThis as { __jarvisTestNavLookup?: HostLookup }).__jarvisTestNavLookup ?? serverLookup;

/** http(s)-адрес по разбору WHATWG — и `http:host`, `http:\host` без «//» (браузер откроет их так же). */
export const isHttpish = (url: string): boolean => /^\s*https?:/iu.test(url);

/** Суд над адресом по ответу DNS: "private" — ведёт внутрь; "timeout" — DNS молчит, адрес не проверить; null — можно. */
export async function dnsVerdict(url: string, lookup?: HostLookup): Promise<{ kind: "private" | "timeout"; text: string } | null> {
  const host = urlHostname(url);
  if (!host) return isHttpish(url) ? { kind: "private", text: "адрес не разобрать" } : null; // http без хоста — fail-closed
  const v = await checkHostPublic(host, { lookup: lookup ?? defaultLookup() });
  const name = host.slice(0, 80);
  if (!v.ok && v.reason === "private") return { kind: "private", text: `имя «${name}» указывает во внутреннюю сеть (${v.address})` };
  if (!v.ok && v.detail === "ETIMEOUT") return { kind: "timeout", text: `DNS не ответил на «${name}» вовремя — адрес не проверить` };
  return null;
}

/** Отказ, если адрес url не прошёл суд по DNS; иначе null. `lookup` — DI стенда (нет → системный DNS). */
export async function navDnsRefusal(tool: string, url: string, lookup?: HostLookup): Promise<ToolResult | null> {
  const v = await dnsVerdict(url, lookup);
  return v ? err(`${tool}: ${v.text} — в браузере не открываю (SSRF-гард по ответу DNS).`) : null;
}

/** SSRF-суд над url навигации web_*: схема и имя (browserUrlBlocked), затем ответ DNS. Отказ → готовый err, иначе null. */
export async function navUrlRefusal(tool: string, url: string, lookup?: HostLookup): Promise<ToolResult | null> {
  if (browserUrlBlocked(url)) {
    return err(`${tool}: адрес заблокирован (внутренняя сеть/loopback/метаданные/file:/chrome: — небезопасно открывать в браузере Джарвиса).`);
  }
  return navDnsRefusal(tool, url, lookup);
}

/**
 * Шаги берста/навыка, которые ОТКРЫВАЮТ URL в браузере владельца (клиент — shell-open, мимо всех серверных гардов):
 * browser.open{url} (голый хост — тоже) и app.launch{app} со схемой http(s). Прочие схемы судят launchDenial клиента и
 * replayUriUnsafe. Первый отказ → err (адверс-ревью: input_batch/skill_execute/реплей раньше не судились вовсе).
 */
export async function stepsNavRefusal(tool: string, steps: ReadonlyArray<{ action?: unknown; params?: Record<string, unknown> }>, lookup?: HostLookup): Promise<ToolResult | null> {
  for (const s of steps) {
    const raw = s.action === "browser.open" ? s.params?.url : s.action === "app.launch" ? s.params?.app : undefined;
    const url = typeof raw === "string" ? raw.trim() : "";
    const http = isHttpish(url) || (s.action === "browser.open" && url !== "" && !/^[a-z][a-z0-9+.-]*:(?!\d)/iu.test(url)); // «host:8787» — порт, не схема
    const target = isHttpish(url) ? url : `https://${url}`; // голый «host[:port]/…» — судим как https
    const refusal = http ? await navUrlRefusal(`${tool} (${String(s.action)})`, target, lookup) : null;
    if (refusal) return refusal;
  }
  return null;
}
