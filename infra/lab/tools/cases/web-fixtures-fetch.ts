/**
 * web_fetch в лаборатории идёт через НАСТОЯЩИЙ `WebProvider` сервера (SSRF-гард, ручные редиректы, кодировки, кап,
 * JSON как есть); поддельным остаётся только сетевой транспорт — «интернет» из таблицы маршрутов. `requested` — какие
 * адреса вообще пытались открыть: гард, сработавший ДО запроса, виден как пустой журнал (запрос во внутреннюю сеть
 * успевает нанести вред, даже если тело читать не стали).
 */
import { WebProvider } from "../../../../apps/server/src/integrations/web.js";
import type { WebTransport } from "../../../../apps/server/src/integrations/pinned-fetch.js";
import type { ToolCase } from "../case-format.js";
import { rigCase } from "./web-fixtures.js";

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}
export type Routes = Record<string, Reply | ((url: string) => Reply)>;

export function fetchRig(routes: Routes) {
  const requested: string[] = [];
  const transport: WebTransport = async (url) => {
    requested.push(url);
    const r = routes[url] ?? routes["*"]; // "*" — маршрут по умолчанию (цепочки адресов, которые не перечислить)
    if (!r) return new Response("нет такого маршрута", { status: 404 });
    const x = typeof r === "function" ? r(url) : r;
    return new Response((x.body ?? "") as BodyInit, { status: x.status ?? 200, headers: x.headers ?? { "content-type": "text/html; charset=utf-8" } });
  };
  return { web: new WebProvider(undefined, transport), requested };
}
export type FetchRig = ReturnType<typeof fetchRig>;

/** Кейс web_fetch над таблицей маршрутов; предикаты читают `rig().requested` ТЕКУЩЕГО запуска. */
export const fetchCase = (routes: Routes, build: (r: () => FetchRig) => ToolCase): ToolCase =>
  rigCase(() => fetchRig(routes), (r) => ({ ctx: { web: r.web } }), build);

/** Текст в windows-1251 (ЦБ РФ и множество сайтов): кириллица одним байтом. Проверка «мусор вместо русского». */
export const cp1251 = (s: string): Uint8Array =>
  Uint8Array.from([...s].map((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0x410 && c <= 0x44f ? c - 0x410 + 0xc0 : c === 0x451 ? 0xb8 : c === 0x401 ? 0xa8 : c;
  }));
