/**
 * B-14 (W4): ОДНО правило «приватный хост» для всех SSRF-гардов — сервер (web.fetch, browserUrlBlocked, ответы
 * расширения) и клиент (невидимый браузер: перехват навигации). Раньше их было два и они разошлись: серверный
 * не считал приватным `.local` и CGNAT, клиентский — IPv4-mapped IPv6.
 *
 * Приватно: loopback (127/8, ::1), «этот хост» (0/8, ::), RFC1918 (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16 — вкл. облачные метаданные, fe80::/10), CGNAT (100.64/10), IPv6 ULA (fc00::/7), IPv4-mapped/
 * -compatible IPv6 с приватным IPv4, имена `localhost`, `*.localhost`, `*.local` (mDNS), `*.internal`.
 * Здесь суд по ИМЕНИ из URL (синхронно, без сети). Публичное имя, указывающее на приватный IP (`localtest.me`,
 * `127.0.0.1.nip.io`), ловит второй слой — суд по ОТВЕТУ DNS (`host-resolve.ts` checkHostPublic + `isPrivateIp`).
 */

/** Хост из URL или голого «host[:port]»: без [] у IPv6, без хвостовой точки, в нижнем регистре. "" — не разобрать. */
export function urlHostname(urlOrHost: string): string {
  const raw = String(urlOrHost ?? "").trim();
  if (!raw) return "";
  try {
    const s = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
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
  return false;
}

/** IPv4 в точечной записи (WHATWG URL уже нормализовал десятичные/hex/octal формы) → приватный? null — не IPv4. */
function ipv4Private(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!m) return null;
  return privateIpv4(Number(m[1]), Number(m[2]));
}

/** IPv6 (без скобок): loopback/unspecified, ULA, link-local, mapped/compatible IPv4. */
function ipv6Private(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{0,2}:/u.test(host)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]?:/u.test(host)) return true; // fe80::/10
  // ::ffff:a.b.c.d / ::a.b.c.d (точечная) и их hex-формы ::ffff:7f00:1 / ::7f00:1 (так нормализует WHATWG URL).
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(host);
  if (dotted) return ipv4Private(dotted[1]!) === true;
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    return privateIpv4(hi >> 8, hi & 0xff);
  }
  return false;
}

/** Приватный/локальный хост (SSRF-класс). Пустой/битый хост (about:blank, data:) — НЕ приватный: сети там нет. */
export function isPrivateHost(urlOrHost: string): boolean {
  const host = urlHostname(urlOrHost);
  if (!host) return false;
  if (host === "localhost" || /\.(?:localhost|local|internal)$/u.test(host)) return true;
  if (host.includes(":")) return ipv6Private(host);
  return ipv4Private(host) === true;
}

/**
 * Голый адрес из ответа DNS (IPv4 или IPv6 без скобок, у link-local бывает зона `%12`) → приватный? `isPrivateHost("::1")`
 * его не разберёт (`https://::1` — не URL → "" → «не приватный»), поэтому IPv6 оборачиваем в [] сами. Непарсящийся
 * адрес — приватный: резолвер вернул мусор, подключаться к нему не будем (fail-closed).
 */
export function isPrivateIp(address: string): boolean {
  const a = String(address ?? "").trim().replace(/%.*$/u, "").replace(/^\[|\]$/gu, "");
  if (!a.includes(":")) return ipv4Private(a) ?? true;
  const host = urlHostname(`http://[${a}]`);
  return host ? ipv6Private(host) : true;
}

/** http(s)-адрес на приватном хосте (для перехвата навигации и ответов вкладок; прочие схемы судит свой гард). */
export function isPrivateHttpUrl(url: string): boolean {
  return /^https?:\/\//iu.test(String(url ?? "").trim()) && isPrivateHost(url);
}
