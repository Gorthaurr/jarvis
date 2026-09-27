/**
 * B-14 (DNS + rebinding): транспорт web.fetch с ПИННИНГОМ адреса. Суд «все адреса публичные» (`checkHostPublic`) идёт
 * ВНУТРИ `lookup` сокета: соединение открывается ровно к проверенному адресу, второго резолва нет — ни
 * `localtest.me`/`*.nip.io` (имя → 127.0.0.1), ни DNS rebinding (проверке — публичный, подключению — 127.0.0.1) не
 * проходят. Глобальный fetch (undici) свой lookup не принимает → node:http(s) и обёртка в WHATWG Response: остальной
 * web.fetch (ручные редиректы с гардом на каждом hop, чтение с капом, кодировки) не меняется. Свои Agent'ы без
 * keep-alive: сокет чужого пула (открытый не через наш lookup) по имени хоста не переиспользуется.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { type HostLookup, checkHostPublic } from "@jarvis/shared";

/** Один HTTP-запрос БЕЗ следования редиректам (цепочку ходит web.fetch сам, с гардом на каждом hop). */
export type WebTransport = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** code ошибки сокета, когда имя указывает во внутреннюю сеть. */
export const PRIVATE_ADDRESS = "EJARVIS_PRIVATE_ADDRESS";

/** `lookup` для net/tls: суд над ответом DNS и выдача ТОЛЬКО проверенных адресов (их сокет и откроет). */
export function pinnedLookup(lookup?: HostLookup): LookupFunction {
  return (hostname, options, callback) => {
    void checkHostPublic(hostname, { lookup }).then((v) => {
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

const agents = { http: new http.Agent({ keepAlive: false }), https: new https.Agent({ keepAlive: false }) };
/** Статусы без тела (Response с телом для них бросает). */
const NULL_BODY = new Set([204, 205, 304]);

function decoderFor(encoding: string): zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | null {
  const e = encoding.trim().toLowerCase();
  if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
  if (e === "br") return zlib.createBrotliDecompress();
  if (e === "deflate") return zlib.createInflate();
  return null;
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
  // Как у fetch: сжатое тело разжимаем прозрачно (длина после разжатия другая — заголовок убираем).
  const decoder = decoderFor(headers.get("content-encoding") ?? "");
  let body: Readable = res;
  if (decoder) {
    headers.delete("content-encoding");
    headers.delete("content-length");
    res.on("error", (e) => decoder.destroy(e));
    body = res.pipe(decoder);
  }
  return new Response(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage ?? "", headers });
}

/** Транспорт web.fetch по умолчанию: GET с пиннингом проверенного адреса. `lookup` — DI стенда (нет → системный DNS). */
export function pinnedTransport(lookup?: HostLookup): WebTransport {
  const pinned = pinnedLookup(lookup);
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const tls = u.protocol === "https:";
      const opts = { method: "GET", headers: { ...init.headers, "accept-encoding": "gzip, br" }, signal: init.signal, lookup: pinned, agent: tls ? agents.https : agents.http };
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
