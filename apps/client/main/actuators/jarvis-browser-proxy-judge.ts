/**
 * B-14 (rebinding, адверс-ревью 27.09): суд пиннинг-прокси над хостом — без ущерба главному процессу Electron.
 *
 * Прокси резолвит КАЖДОЕ соединение браузера, и подресурсами управляет страница. getaddrinfo в главном процессе
 * libuv пускает максимум в ДВА потока («медленный» I/O), а таймаут `checkHostPublic` (3 с) отпускает только промис —
 * поток занят до ответа ОС: полдюжины картинок на одноярусные имена (LLMNR ~2 с на Windows) выстроили очередь, и
 * легитимные хосты (и гард навигации) десятки секунд получали «не разрешилось» (стенд ревью). Поэтому:
 *  - одноярусное имя (`router`, `jx1`) — интранет по определению: отказ БЕЗ резолва (и без LLMNR-запроса в LAN);
 *    то же правило у гарда навигации (`checkBrowserHost`), иначе страница взяла бы ту же цену через iframe;
 *  - резолвов разом — не больше `slots` (1; гард — свой `limitLookup` B-14); слот держится, пока не ответил сам
 *    резолвер, а не до таймаута вердикта; запрос, чей клиент уже ушёл (`alive` → false), снимается без резолва;
 *  - одно имя в полёте — один резолв; публичный вердикт помнится `cacheMs` — пиннинг цел: подключение идёт к адресам
 *    ВЕРДИКТА, так что DNS, сменивший ответ на 127.0.0.1, до истечения кеша просто не спрашивается.
 */
import { type HostLookup, type HostVerdict, type LocalInterfaces, Semaphore, checkHostPublic, systemLookup } from "@jarvis/shared";

/** Одноярусное имя (без точки и не IPv6) — интранет: LLMNR/NetBIOS/суффикс поиска ведут в LAN, резолв не нужен. */
export const isIntranetName = (host: string): boolean => Boolean(host) && !host.includes(".") && !host.includes(":");

/** Суд над хостом для невидимого браузера: интранет-имя — отказ без резолва, иначе `checkHostPublic`. */
export function checkBrowserHost(host: string, lookup?: HostLookup, timeoutMs?: number, interfaces?: LocalInterfaces): Promise<HostVerdict> {
  return isIntranetName(host) ? Promise.resolve({ ok: false, reason: "private", address: host }) : checkHostPublic(host, { lookup, timeoutMs, interfaces });
}

export interface HostJudgeOpts {
  /** Резолвер (DI стенда); нет → системный getaddrinfo. */
  lookup?: HostLookup;
  slots?: number;
  cacheMs?: number;
  /** Таймаут вердикта (по умолчанию — `checkHostPublic`, 3 с). */
  timeoutMs?: number;
  /** Свои интерфейсы ПК (DI стенда); нет → системный список (`local-nets.ts`). */
  interfaces?: LocalInterfaces;
}

const SLOTS = 1;
/** ≥ окна сопоставления гарда (35 с): хост, прошедший суд, в этом окне не получит ложный блок от сбоя DNS. */
const CACHE_MS = 40_000;
const CACHE_MAX = 256;

export class HostJudge {
  private readonly slots: Semaphore;
  private readonly inflight = new Map<string, { promise: Promise<HostVerdict>; alive: Array<() => boolean> }>();
  private readonly cache = new Map<string, { verdict: HostVerdict; until: number }>();

  constructor(private readonly opts: HostJudgeOpts = {}) {
    this.slots = new Semaphore(opts.slots ?? SLOTS);
  }

  /** host — канонический (`urlHostname`); alive — жив ли ещё ждущий (закрытый клиент резолв не держит). */
  judge(host: string, alive: () => boolean = () => true): Promise<HostVerdict> {
    if (isIntranetName(host)) return checkBrowserHost(host);
    const hit = this.cache.get(host);
    if (hit && hit.until > Date.now()) return Promise.resolve(hit.verdict);
    let entry = this.inflight.get(host);
    if (!entry) {
      const waiting: Array<() => boolean> = [];
      entry = { promise: this.run(host, waiting).finally(() => this.inflight.delete(host)), alive: waiting };
      this.inflight.set(host, entry);
    }
    entry.alive.push(alive);
    return entry.promise;
  }

  private async run(host: string, alive: Array<() => boolean>): Promise<HostVerdict> {
    await this.slots.acquire();
    let raw: Promise<unknown> = Promise.resolve();
    const lookup: HostLookup = (h) => {
      const q = (this.opts.lookup ?? systemLookup)(h);
      raw = q;
      return q;
    };
    try {
      if (!alive.some((a) => a())) return { ok: false, reason: "unresolved", detail: "запрос снят: клиент ушёл до резолва" };
      const verdict = await checkBrowserHost(host, lookup, this.opts.timeoutMs, this.opts.interfaces);
      if (verdict.ok) this.remember(host, verdict);
      return verdict;
    } finally {
      void raw.then(() => this.slots.release(), () => this.slots.release());
    }
  }

  private remember(host: string, verdict: HostVerdict): void {
    this.cache.delete(host);
    this.cache.set(host, { verdict, until: Date.now() + (this.opts.cacheMs ?? CACHE_MS) });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }
}
