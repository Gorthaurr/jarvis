/**
 * B-14 (DNS): суд над адресом НАВИГАЦИИ браузера по ответу DNS — до отправки клиенту/расширению. browserUrlBlocked
 * судит имя из URL, и `localtest.me` / `127.0.0.1.nip.io` (→ 127.0.0.1) он пропускал: невидимый Chrome Джарвиса
 * реально сходил на dev-HTTP сервера (живой факт 27.09). Здесь: приватен любой адрес ответа → честный отказ.
 *
 * «Не разрешилось» — ПРОПУСКАЕМ: сервер сам не подключается, резолвит браузер. Невидимый браузер судит КАЖДЫЙ
 * Document-запрос сам (NavGuard; там «не разрешилось» = отказ), а у Chrome владельца имя, не разрешённое DNS этой же
 * машины, как правило не откроется. Rebinding (второй резолв браузера ответит иначе) этот слой не закрывает —
 * см. docs/SECURITY.md «SSRF по DNS».
 *
 * Порядок в dispatch: суд — ДО §14-вопроса и ДО памяти цели web_act (rememberWebTarget). Раньше память стояла выше
 * гарда, и отклонённый URL становился «последней целью» web_act.
 */
import { type HostLookup, checkHostPublic, urlHostname } from "@jarvis/shared";
import type { ToolResult } from "./dispatch.js";
import { browserUrlBlocked, err } from "./dispatch-util.js";

/** Отказ, если имя из url указывает во внутреннюю сеть; иначе null. `lookup` — DI стенда (нет → системный DNS). */
export async function navDnsRefusal(tool: string, url: string, lookup?: HostLookup): Promise<ToolResult | null> {
  const host = urlHostname(url);
  if (!host) return null; // схему и битый URL уже судит browserUrlBlocked
  const v = await checkHostPublic(host, { lookup });
  if (v.ok || v.reason !== "private") return null;
  return err(`${tool}: имя «${host}» указывает во внутреннюю сеть (${v.address}) — в браузере не открываю (SSRF-гард по ответу DNS).`);
}

/** SSRF-суд над url навигации web_*: схема и имя (browserUrlBlocked), затем ответ DNS. Отказ → готовый err, иначе null. */
export async function navUrlRefusal(tool: string, url: string, lookup?: HostLookup): Promise<ToolResult | null> {
  if (browserUrlBlocked(url)) {
    return err(`${tool}: адрес заблокирован (внутренняя сеть/loopback/метаданные/file:/chrome: — небезопасно открывать в браузере Джарвиса).`);
  }
  return navDnsRefusal(tool, url, lookup);
}
