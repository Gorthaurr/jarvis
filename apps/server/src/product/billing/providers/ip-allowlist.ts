/**
 * Allowlist IP для вебхуков провайдера, который их не подписывает (ЮKassa публикует диапазоны источников).
 * Чистые функции: IPv4/IPv6 → BigInt, CIDR-сравнение. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) приводится к IPv4.
 * Это рубеж в глубину, не единственный: сумму/статус вебхука провайдер всё равно перечитывает по API.
 */

function parseIpv4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let out = 0n;
  for (let i = 1; i <= 4; i++) {
    const oct = Number(m[i]);
    if (oct > 255) return null;
    out = (out << 8n) | BigInt(oct);
  }
  return out;
}

function parseIpv6(s: string): bigint | null {
  if (!/^[0-9a-f:]+$/i.test(s) || s.split("::").length > 2) return null;
  const [head, tail] = s.split("::");
  const hs = head ? head.split(":") : [];
  const ts = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const missing = 8 - hs.length - ts.length;
  if (missing < 0 || (s.indexOf("::") === -1 && missing !== 0)) return null;
  const groups = [...hs, ...Array<string>(missing).fill("0"), ...ts];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out = (out << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return out;
}

/** {value, bits} или null для мусора. Зона (`%eth0`) и порт не поддерживаются — это не адрес источника. */
export function parseIp(raw: string): { value: bigint; bits: 32 | 128 } | null {
  const s = raw.trim();
  // IPv4-mapped IPv6 — это IPv4-источник (так его отдаёт dual-stack сокет): сравниваем в семействе IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  const v4 = parseIpv4(mapped ? (mapped[1] ?? "") : s);
  if (v4 !== null) return { value: v4, bits: 32 };
  if (mapped) return null;
  const v6 = parseIpv6(s);
  return v6 === null ? null : { value: v6, bits: 128 };
}

/** Входит ли ip в entry (`a.b.c.d`, `a.b.c.d/24`, `2a02:5180::/32`). Несовпадение семейств → false. */
export function ipMatches(ip: string, entry: string): boolean {
  const [net, prefixRaw] = entry.trim().split("/");
  const a = parseIp(ip);
  const n = parseIp(net ?? "");
  if (!a || !n || a.bits !== n.bits) return false;
  const prefix = prefixRaw === undefined ? n.bits : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > n.bits) return false;
  const shift = BigInt(n.bits - prefix);
  return a.value >> shift === n.value >> shift;
}

export function ipAllowed(ip: string | undefined, allowlist: readonly string[]): boolean {
  if (!ip) return false;
  return allowlist.some((e) => ipMatches(ip, e));
}
