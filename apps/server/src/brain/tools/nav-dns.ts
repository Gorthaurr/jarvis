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
import { type HostLookup, checkHostPublic, urlHostname } from "@jarvis/shared";
import type { ToolResult } from "./dispatch.js";
import { browserUrlBlocked, err } from "./dispatch-util.js";

/** Почему адрес url нельзя открыть в браузере по ответу DNS (текст для модели), иначе null. */
async function dnsBlockReason(url: string, lookup?: HostLookup): Promise<string | null> {
  const host = urlHostname(url);
  if (!host) return null; // схему и битый URL уже судит browserUrlBlocked
  const v = await checkHostPublic(host, { lookup });
  const name = host.slice(0, 80);
  if (!v.ok && v.reason === "private") return `имя «${name}» указывает во внутреннюю сеть (${v.address})`;
  if (!v.ok && v.detail === "ETIMEOUT") return `DNS не ответил на «${name}» вовремя — адрес не проверить`;
  return null;
}

/** Адрес вкладки/навигации ведёт внутрь по ответу DNS (для суда над ответами расширения). */
export async function privateByDns(url: string, lookup?: HostLookup): Promise<boolean> {
  return /^https?:\/\//iu.test(url.trim()) && (await dnsBlockReason(url, lookup)) !== null;
}

/** Отказ, если адрес url не прошёл суд по DNS; иначе null. `lookup` — DI стенда (нет → системный DNS). */
export async function navDnsRefusal(tool: string, url: string, lookup?: HostLookup): Promise<ToolResult | null> {
  const why = await dnsBlockReason(url, lookup);
  return why ? err(`${tool}: ${why} — в браузере не открываю (SSRF-гард по ответу DNS).`) : null;
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
    const http = /^https?:\/\//iu.test(url) || (s.action === "browser.open" && url !== "" && !/^[a-z][a-z0-9+.-]*:(?!\d)/iu.test(url)); // «host:8787» — порт, не схема
    const target = /^https?:\/\//iu.test(url) ? url : `https://${url}`; // голый «host[:port]/…» — судим как https
    const refusal = http ? await navUrlRefusal(`${tool} (${String(s.action)})`, target, lookup) : null;
    if (refusal) return refusal;
  }
  return null;
}
