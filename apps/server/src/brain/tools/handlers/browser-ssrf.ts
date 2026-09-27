/**
 * B-14 (W4): SSRF-гард ОТВЕТОВ вкладок Chrome владельца (расширение). browser_open режет приватный url, но вкладку
 * уводит сама страница — клик по подложенной ссылке, редирект, `location=` из скрипта, «назад» в историю. Раньше
 * browser_read/inspect отдавали модели страницу роутера (192.168.0.1), админку на localhost или метаданные облака —
 * а оттуда инъекция уводит содержимое наружу. Запрос в Chrome владельца сервер предотвратить не может (это делает
 * сам Chrome/расширение); сервер НЕ ОТДАЁТ модели содержимое и адрес вкладки на внутреннем хосте и честно об этом
 * говорит. Правило «приватный хост» — одно на сервер и клиент (`@jarvis/shared` private-host.ts); B-14 (DNS, адверс-
 * ревью): плюс суд по ОТВЕТУ DNS — вкладка на `localtest.me`/`*.nip.io` (→ 127.0.0.1) тоже внутренняя.
 */
import { type HostLookup, isPrivateHttpUrl } from "@jarvis/shared";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";
import { privateByDns } from "../nav-dns.js";
import { resolvePlace } from "../web-place.js";

const INTERNAL = "(локальная сеть/loopback/метаданные облака)";
const REOPEN = "Страница могла увести вкладку ссылкой или редиректом — открой нужный сайт заново (browser_open).";

/** Адреса ответа расширения, по которым видно, ГДЕ вкладка/фрейм сейчас (все — page-controlled). */
async function privateUrlOf(reply: unknown, lookup?: HostLookup): Promise<boolean> {
  if (!reply || typeof reply !== "object") return false;
  const r = reply as Record<string, unknown>;
  const urls = ["url", "navigated", "frameUrl"].map((k) => r[k]).filter((u): u is string => typeof u === "string" && u !== "");
  if (urls.some((u) => isPrivateHttpUrl(u))) return true;
  return (await Promise.all(urls.map((u) => privateByDns(u, lookup)))).some(Boolean);
}

/** browser_read/browser_inspect: вкладка на внутреннем адресе → содержимое не отдаём (честный отказ). */
export async function privateTabRead(tool: string, reply: unknown, lookup?: HostLookup): Promise<ToolResult | null> {
  if (!(await privateUrlOf(reply, lookup))) return null;
  return err(`${tool}: вкладка сейчас на внутреннем адресе ${INTERNAL} — содержимое не читаю и модели не отдаю (защита от SSRF). ${REOPEN}`);
}

/**
 * browser_act: действие УЖЕ исполнено (закон 1 — не «не вышло»), но вкладка/фрейм ушли на внутренний адрес: адрес,
 * значение поля и прочие данные страницы не отдаём, долг сверки не снимаем, дальше там не действуем.
 */
export async function privateActResult(intent: string, reply: unknown, lookup?: HostLookup): Promise<ToolResult | null> {
  if (!(await privateUrlOf(reply, lookup))) return null;
  return ok(`Сделал «${intent}», но вкладка ушла на внутренний адрес ${INTERNAL} — адрес и содержимое не показываю и там не действую. ${REOPEN}`);
}

/** Снимок вкладки (view:image): живой адрес вкладки — ДО снимка; на внутреннем адресе картинку не делаем. */
export async function privatePlaceBlock(ctx: ToolContext, target: { url: string; tabId?: number }, tool: string): Promise<ToolResult | null> {
  const place = await resolvePlace(ctx, target);
  return privateTabRead(tool, { url: place.url }, ctx.resolveHost);
}
