/**
 * B-14 (rebinding, адверс-ревью 27.09): суд пиннинг-прокси над хостом — без ущерба главному процессу Electron.
 *
 * Прокси резолвит КАЖДОЕ соединение браузера, и подресурсами управляет страница. getaddrinfo в главном процессе
 * libuv пускает максимум в ДВА потока («медленный» I/O), а таймаут `checkHostPublic` (3 с) отпускает только промис —
 * поток занят до ответа ОС: полдюжины картинок на одноярусные имена (LLMNR ~2 с на Windows) выстроили очередь, и
 * легитимные хосты (и гард навигации) десятки секунд получали «не разрешилось» (стенд ревью). Поэтому:
 *  - одноярусное имя (`router`, `jx1`) — интранет по определению: отказ БЕЗ резолва (и без LLMNR-запроса в LAN);
 *  - резолвов разом — не больше `slots` (1: второй поток остаётся гарду навигации); слот держится, пока не ответил сам
 *    резолвер, а не до таймаута вердикта; запрос, чей клиент уже ушёл (`alive` → false), снимается без резолва;
 *  - одно имя в полёте — один резолв; публичный вердикт помнится `cacheMs` — пиннинг цел: подключение идёт к адресам
 *    ВЕРДИКТА, так что DNS, сменивший ответ на 127.0.0.1, до истечения кеша просто не спрашивается.
 */
import { type HostLookup, type HostVerdict, Semaphore, checkHostPublic, systemLookup } from "@jarvis/shared";

export interface HostJudgeOpts {
  /** Резолвер (DI стенда); нет → системный getaddrinfo. */
  lookup?: HostLookup;
  slots?: number;
  cacheMs?: number;
  /** Таймаут вердикта (по умолчанию — `checkHostPublic`, 3 с). */
  timeoutMs?: number;
}

const SLOTS = 1;
const CACHE_MS = 30_000;
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
    if (host && !host.includes(".") && !host.includes(":")) return Promise.resolve({ ok: false, reason: "private", address: host });
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
    if (!alive.some((a) => a())) {
      this.slots.release();
      return { ok: false, reason: "unresolved", detail: "запрос снят: клиент ушёл до резолва" };
    }
    let raw: Promise<unknown> = Promise.resolve();
    const lookup: HostLookup = (h) => {
      const q = (this.opts.lookup ?? systemLookup)(h);
      raw = q;
      return q;
    };
    try {
      const verdict = await checkHostPublic(host, { lookup, timeoutMs: this.opts.timeoutMs });
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
