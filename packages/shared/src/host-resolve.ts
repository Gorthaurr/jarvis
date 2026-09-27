/**
 * B-14 (DNS): имя хоста → ответ DNS → «все адреса публичные?». Правило по ИМЕНИ (private-host.ts) не видит публичное
 * имя, указывающее внутрь: `localtest.me`, `127.0.0.1.nip.io` → 127.0.0.1 (живой факт 27.09 — невидимый Chrome сходил
 * на dev-HTTP сервера). Здесь тот же суд, но по ОТВЕТУ резолвера: ЛЮБОЙ приватный адрес среди ответов → отказ
 * (мультизапись «публичный + 127.0.0.1» не проходит); не разрешилось/таймаут → отдельный исход `unresolved`.
 *
 * Сам вердикт — не пиннинг: подключающийся обязан открыть сокет к ПРОВЕРЕННОМУ адресу (сервер: `lookup` сокета в
 * integrations/pinned-fetch.ts), иначе второй резолв (DNS rebinding) ответит иначе. Резолвер — DI (`HostLookup`):
 * стенды подставляют таблицу имён; по умолчанию — системный getaddrinfo (тот же, что у сокетов Node).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isPrivateHost, isPrivateIp } from "./private-host.js";

/** Имя → все адреса ответа (без скобок). Бросает, если имя не разрешилось. */
export type HostLookup = (host: string) => Promise<string[]>;

export type HostVerdict =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: "private"; address: string }
  | { ok: false; reason: "unresolved"; detail: string };

export const systemLookup: HostLookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** getaddrinfo своего таймаута не имеет: зависший резолв не должен вешать навигацию/ответ голосом. */
const LOOKUP_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`DNS не ответил за ${ms} мс`), { code: "ETIMEOUT" })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const isIpLiteral = (h: string): boolean => h.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(h);

/**
 * Суд над хостом по имени И по ответу DNS. IP-литерал судится сам (без резолва); имя из правила по имени
 * (`localhost`, `*.local`…) — отказ без сети; иначе резолв с таймаутом и отказ, если приватен ЛЮБОЙ адрес.
 */
export async function checkHostPublic(host: string, opts: { lookup?: HostLookup; timeoutMs?: number } = {}): Promise<HostVerdict> {
  const h = String(host ?? "").trim().replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (!h) return { ok: false, reason: "unresolved", detail: "пустое имя хоста" };
  if (isIpLiteral(h)) return isPrivateIp(h) ? { ok: false, reason: "private", address: h } : { ok: true, addresses: [h] };
  if (isPrivateHost(h)) return { ok: false, reason: "private", address: h };
  let addresses: string[];
  try {
    addresses = await withTimeout((opts.lookup ?? systemLookup)(h), opts.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return { ok: false, reason: "unresolved", detail: typeof code === "string" ? code : e instanceof Error ? e.message : String(e) };
  }
  if (!addresses.length) return { ok: false, reason: "unresolved", detail: "пустой ответ DNS" };
  const bad = addresses.find((a) => isPrivateIp(a));
  return bad ? { ok: false, reason: "private", address: bad } : { ok: true, addresses };
}

/**
 * Резолвер для ЧАСТЫХ вызовов (перехват каждой навигации в процессе клиента): getaddrinfo идёт в пул libuv (4 потока на
 * весь процесс, fs/zlib/crypto там же), а таймаут withTimeout поток НЕ освобождает — страница с iframe на имена с
 * молчащим NS занимала бы весь пул. Здесь: ≤ concurrency одновременных запросов, одно имя в полёте — один запрос,
 * удачный ответ — кеш ttlMs (ошибки не кешируем).
 */
export function limitLookup(lookup: HostLookup, opts: { concurrency?: number; ttlMs?: number } = {}): HostLookup {
  const max = opts.concurrency ?? 2;
  const ttl = opts.ttlMs ?? 30_000;
  let active = 0;
  const queue: Array<() => void> = [];
  // Слот освобождается передачей следующему в очереди (без окна, где новый вызов обгонит разбуженного).
  const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active += 1;
    else await new Promise<void>((r) => queue.push(r));
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
  const cache = new Map<string, { at: number; addresses: string[] }>();
  const inflight = new Map<string, Promise<string[]>>();
  return (host) => {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.addresses);
    const pending = inflight.get(host);
    if (pending) return pending;
    const p = slot(() => lookup(host))
      .then((addresses) => {
        cache.delete(host);
        cache.set(host, { at: Date.now(), addresses });
        if (cache.size > 500) cache.delete(cache.keys().next().value as string);
        return addresses;
      })
      .finally(() => inflight.delete(host));
    inflight.set(host, p);
    return p;
  };
}
