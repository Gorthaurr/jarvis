/**
 * B-14 (W4): ОДНО правило «приватный хост» для всех SSRF-гардов — сервер (web.fetch, browserUrlBlocked, ответы
 * расширения) и клиент (невидимый браузер: перехват навигации). Раньше их было два и они разошлись: серверный
 * не считал приватным `.local` и CGNAT, клиентский — IPv4-mapped IPv6.
 *
 * Приватно: loopback (127/8, ::1), «этот хост» (0/8, ::), RFC1918 (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16 — вкл. облачные метаданные, fe80::/10), CGNAT (100.64/10), IPv6 ULA (fc00::/7), IPv4-mapped/
 * -compatible IPv6 с приватным IPv4, имена `localhost`, `*.localhost`, `*.local` (mDNS), `*.internal`, и адреса
 * САМОГО ПК с их on-link сетями (Radmin VPN 26/8, PPPoE, глобальный IPv6 — `local-nets.ts`; `interfaces` — DI стенда).
 * Здесь суд по ИМЕНИ из URL (синхронно, без сети). Публичное имя, указывающее на приватный IP (`localtest.me`,
 * `127.0.0.1.nip.io`), ловит второй слой — суд по ОТВЕТУ DNS (`host-resolve.ts` checkHostPublic + `isPrivateIp`).
 */

import { type LocalInterfaces, isLocalNetAddress } from "./local-nets.js";
export type { LocalInterfaces }; // DI стенда для потребителей правила (прокси, pinned-fetch)

/** Схемы, у которых WHATWG находит хост и БЕЗ «//»: `http:evil.example`, `http:\evil.example`, `https:/x` → хост x. */
const SPECIAL_SCHEME = /^(?:https?|wss?|ftp):/iu;

/**
 * Хост из URL или голого «host[:port]»: без [] у IPv6, без хвостовой точки, в нижнем регистре. "" — не разобрать.
 * Адверс-ревью р2: `http:evil.example` раньше шёл как голый хост (`https://http:evil.example` → "") и проходил
 * DNS-суд пустым, хотя `new URL` и браузер открывают его как http://evil.example/ — разбор тот же, что у них.
 */
export function urlHostname(urlOrHost: string): string {
  const raw = String(urlOrHost ?? "").trim();
  if (!raw) return "";
  try {
    const s = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) || SPECIAL_SCHEME.test(raw) ? raw : `https://${raw}`;
    return new URL(s).hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  } catch {
    return "";
  }
}

function privateIpv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private-A / «этот хост»
  if (a === 192 && b === 168) return true; // private-C
  if (a === 169 && b === 254) return true; // link-local (169.254.169.254 — метаданные облака)
  if (a === 172 && b >= 16 && b <= 31) return true; // private-B
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  if (a >= 224) return true; // мультикаст 224/4, резерв 240/4, broadcast — не веб-сервер
  return false;
}

/** IPv4 в точечной записи (WHATWG URL уже нормализовал десятичные/hex/octal формы) → приватный? null — не IPv4. */
function ipv4Private(host: string, interfaces?: LocalInterfaces): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!m) return null;
  return privateIpv4(Number(m[1]), Number(m[2])) || isLocalNetAddress(host, interfaces);
}

/** IPv6 (без скобок, любая запись) → 8 чисел; хвост a.b.c.d разворачивается. null — не IPv6. */
function hextets(host: string): number[] | null {
  let h = host;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    h = `${h.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parts = h.split("::");
  if (parts.length > 2) return null;
  const side = (x: string | undefined) => (x ? x.split(":").map((t) => (/^[0-9a-f]{1,4}$/iu.test(t) ? Number.parseInt(t, 16) : Number.NaN)) : []);
  const head = side(parts[0]);
  const tail = side(parts[1]);
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  return fill >= 0 && all.length === 8 && all.every((n) => Number.isInteger(n)) ? all : null;
}

/**
 * IPv6 (без скобок): loopback/unspecified, ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, мультикаст, и
 * ВСЕ формы со встроенным IPv4 — mapped/compatible, SIIT ::ffff:0:0/96, NAT64 64:ff9b::/96 (+ локальный /48), 6to4
 * 2002::/16 — по встроенному адресу (ЦЕЛИКОМ: он же может быть адресом своего интерфейса); Teredo 2001::/32 — целиком
 * (веб-сервер на нём не живёт); свой адрес/сеть интерфейса. Непарсящийся — приватный.
 */
function ipv6Private(host: string, interfaces?: LocalInterfaces): boolean {
  const x = hextets(host);
  if (!x) return true;
  const quad = (i: number) => [x[i]! >> 8, x[i]! & 0xff, x[i + 1]! >> 8, x[i + 1]! & 0xff].join("."); // IPv4 в хекстетах i, i+1
  const v4 = (i: number) => privateIpv4(x[i]! >> 8, x[i]! & 0xff) || isLocalNetAddress(quad(i), interfaces);
  const zeros = (n: number) => x.slice(0, n).every((v) => v === 0);
  if (zeros(7) && x[7]! <= 1) return true; // :: и ::1
  if ((x[0]! & 0xfe00) === 0xfc00 || (x[0]! & 0xffc0) === 0xfe80 || (x[0]! & 0xffc0) === 0xfec0 || x[0]! >= 0xff00) return true;
  if (zeros(5) && (x[5] === 0 || x[5] === 0xffff)) return v4(6); // ::a.b.c.d, ::ffff:a.b.c.d
  if (zeros(4) && x[4] === 0xffff && x[5] === 0) return v4(6); // SIIT
  if (x[0] === 0x64 && x[1] === 0xff9b) return x[2] === 1 || v4(6); // NAT64
  if (x[0] === 0x2002) return v4(1); // 6to4
  if (x[0] === 0x2001 && x[1] === 0) return true; // Teredo
  return isLocalNetAddress(x.map((h) => h.toString(16)).join(":"), interfaces);
}

/** Приватный/локальный хост (SSRF-класс). Пустой/битый хост (about:blank, data:) — НЕ приватный: сети там нет. */
export function isPrivateHost(urlOrHost: string, interfaces?: LocalInterfaces): boolean {
  const host = urlHostname(urlOrHost);
  if (!host) return false;
  if (host === "localhost" || /\.(?:localhost|local|internal)$/u.test(host)) return true;
  if (host.includes(":")) return ipv6Private(host, interfaces);
  return ipv4Private(host, interfaces) === true;
}

/**
 * Голый адрес из ответа DNS (IPv4 или IPv6 без скобок, у link-local бывает зона `%12`) → приватный? `isPrivateHost("::1")`
 * его не разберёт (`https://::1` — не URL → "" → «не приватный»), поэтому IPv6 оборачиваем в [] сами. Непарсящийся
 * адрес — приватный: резолвер вернул мусор, подключаться к нему не будем (fail-closed).
 */
export function isPrivateIp(address: string, interfaces?: LocalInterfaces): boolean {
  const a = String(address ?? "").trim().replace(/%.*$/u, "").replace(/^\[|\]$/gu, "");
  if (!a.includes(":")) {
    const oct = a.split(".");
    if (oct.length !== 4 || oct.some((o) => !/^(0|[1-9]\d{0,2})$/u.test(o) || Number(o) > 255)) return true; // «999.1.1.1», «01.02.03.04»
    return ipv4Private(a, interfaces) === true;
  }
  const host = urlHostname(`http://[${a}]`);
  return host ? ipv6Private(host, interfaces) : true;
}

/** http(s)-адрес на приватном хосте (для перехвата навигации и ответов вкладок; прочие схемы судит свой гард). */
export function isPrivateHttpUrl(url: string, interfaces?: LocalInterfaces): boolean {
  return /^https?:/iu.test(String(url ?? "").trim()) && isPrivateHost(url, interfaces); // и `http:host` без «//»
}
