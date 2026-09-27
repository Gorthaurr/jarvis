/**
 * B-14 (DNS + rebinding): транспорт web.fetch с ПИННИНГОМ адреса. Суд «все адреса публичные» (`checkHostPublic`) идёт
 * ВНУТРИ `lookup` сокета: соединение открывается ровно к проверенному адресу, второго резолва нет — ни
 * `localtest.me`/`*.nip.io` (имя → 127.0.0.1), ни DNS rebinding (проверке — публичный, подключению — 127.0.0.1) не
 * проходят. Глобальный fetch (undici) свой lookup не принимает → node:http(s) и обёртка в WHATWG Response: остальной
 * web.fetch (ручные редиректы с гардом на каждом hop, чтение с капом, кодировки) не меняется. Свои Agent'ы с keep-alive:
 * в их пуле только сокеты, открытые через pinnedLookup (к проверенному адресу), — переиспользовать их безопасно;
 * глобальный пул (сокеты не через наш lookup) не трогаем.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { type Duplex, Readable, pipeline } from "node:stream";
import zlib from "node:zlib";
import { type HostLookup, type LocalInterfaces, checkHostPublic } from "@jarvis/shared";

/** Один HTTP-запрос БЕЗ следования редиректам (цепочку ходит web.fetch сам, с гардом на каждом hop). */
export type WebTransport = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** code ошибки сокета, когда имя указывает во внутреннюю сеть. */
export const PRIVATE_ADDRESS = "EJARVIS_PRIVATE_ADDRESS";

/**
 * `lookup` для net/tls: суд над ответом DNS и выдача ТОЛЬКО проверенных адресов (их сокет и откроет). IP-литерал
 * Node в lookup НЕ передаёт — его судит `isFetchUrlAllowed` (web.ts) тем же общим правилом. `interfaces` — DI стенда.
 */
export function pinnedLookup(lookup?: HostLookup, interfaces?: LocalInterfaces): LookupFunction {
  return (hostname, options, cb) => {
    let done = false; // ровно один ответ сокету, даже если колбэк бросит
    const callback = ((...args: Parameters<typeof cb>) => {
      if (done) return;
      done = true;
      cb(...args);
    }) as typeof cb;
    void checkHostPublic(hostname, { lookup, interfaces }).then((v) => {
      if (!v.ok) {
        const private_ = v.reason === "private";
        const msg = private_ ? `имя «${hostname}» указывает во внутреннюю сеть (${v.address}) — не подключаюсь` : `DNS: «${hostname}» не разрешилось (${v.detail})`;
        return callback(Object.assign(new Error(msg), { code: private_ ? PRIVATE_ADDRESS : "ENOTFOUND" }), "");
      }
      const all = v.addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      const fam = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family; // Node пускает и строку
      const pool = fam === 4 || fam === 6 ? all.filter((a) => a.family === fam) : all;
      if (!pool.length) return callback(Object.assign(new Error(`DNS: у «${hostname}» нет адреса нужного семейства`), { code: "ENOTFOUND" }), "");
      if (options.all) return callback(null, pool);
      return callback(null, pool[0]!.address, pool[0]!.family);
    }).catch((e: unknown) => callback(e as NodeJS.ErrnoException, "")); // необработанный reject = крах процесса сервера
  };
}

const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
/** Статусы без тела (Response с телом для них бросает). */
const NULL_BODY = new Set([204, 205, 304]);

/** Цепочка разжатия по Content-Encoding (`gzip, br` — снимаем в обратном порядке). Неизвестное сжатие → null. */
function decodersFor(encoding: string): Duplex[] | null {
  const out: Duplex[] = [];
  for (const e of encoding.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t && t !== "identity").reverse()) {
    if (e === "gzip" || e === "x-gzip") out.push(zlib.createGunzip());
    else if (e === "br") out.push(zlib.createBrotliDecompress());
    else if (e === "deflate") out.push(zlib.createInflate());
    else return null;
  }
  return out;
}

/** Ответ node:http → WHATWG Response (как у fetch: разжатие, статусы без тела). Экспорт — для теста механики. */
export function toResponse(res: http.IncomingMessage): Response {
  const raw = res.statusCode ?? 502;
  const status = raw >= 200 && raw <= 599 ? raw : 502;
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      try {
        headers.append(k, one);
      } catch {
        /* невалидный заголовок — пропускаем, тело важнее */
      }
    }
  }
  if (NULL_BODY.has(status)) {
    res.resume();
    return new Response(null, { status, headers });
  }
  // Как у fetch: сжатое тело разжимаем прозрачно (длина после разжатия другая — заголовок убираем). Неизвестное сжатие —
  // отказ: сырые байты ушли бы модели «текстом страницы» (закон 1). pipeline: отмена/ошибка любого звена рушит и сокет.
  const encoding = headers.get("content-encoding") ?? "";
  const decoders = decodersFor(encoding);
  if (!decoders) {
    res.destroy();
    throw new Error(`неизвестное сжатие ответа «${encoding.slice(0, 40)}» — тело не прочитать`);
  }
  let body: Readable = res;
  if (decoders.length) {
    headers.delete("content-encoding");
    headers.delete("content-length");
    pipeline([res, ...decoders], () => undefined);
    body = decoders[decoders.length - 1]!;
  }
  return new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage ?? "", headers });
}

/** Транспорт web.fetch по умолчанию: GET с пиннингом проверенного адреса. `lookup`/`interfaces` — DI стенда (нет → система). */
export function pinnedTransport(lookup?: HostLookup, interfaces?: LocalInterfaces): WebTransport {
  const pinned = pinnedLookup(lookup, interfaces);
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const tls = u.protocol === "https:";
      const opts = { method: "GET", headers: { accept: "*/*", ...init.headers, "accept-encoding": "gzip, br" }, signal: init.signal, lookup: pinned, agent: tls ? agents.https : agents.http };
      // Бросок в колбэке ответа — неперехваченное исключение процесса сервера: только через reject.
      const req = (tls ? https : http).request(u, opts, (res) => {
        try {
          resolve(toResponse(res));
        } catch (e) {
          res.destroy();
          reject(e);
        }
      });
      req.on("error", reject);
      req.end();
    });
}
