/**
 * B-14 (DNS rebinding, 27.09): локальный SOCKS5-прокси ПИННИНГА адреса для невидимого браузера Джарвиса.
 *
 * Гард навигации (jarvis-browser-nav-guard.ts) судит имя и ответ DNS, но подключается Chrome — и резолвит САМ, после
 * нас: DNS атакующего с TTL 0 отвечал гарду публичным адресом, а Chrome — 127.0.0.1, и `web_read` читал внутреннюю
 * страницу. Теперь Chrome ходит ТОЛЬКО через этот прокси (`pinProxyArgs`: SOCKS5 у Chrome резолвит на стороне прокси,
 * `<-loopback>` снимает неявный обход 127.0.0.1/localhost): суд `checkHostPublic` — один раз на соединение, и сокет
 * открывается ровно к ПРОВЕРЕННЫМ адресам (синтетический lookup, второго резолва нет — тот же приём, что серверный
 * pinned-fetch). Суд с защитой пула резолвера главного процесса — jarvis-browser-proxy-judge.ts. Приватный адрес → ответ 0x02 (запрещено правилами), не разрешилось → 0x04; `onBlock` — синхронно ДО
 * ответа, чтобы гард сопоставил блок с отпущенным переходом раньше, чем навигация вернёт ошибку. Заодно режутся
 * ПОДРЕСУРСЫ (fetch/XHR/img/wss) к внутренним адресам — их перехват навигации не видит.
 *
 * Провод SOCKS5 (no-auth CONNECT — Chrome большего не шлёт) — jarvis-browser-socks5.ts. UDP нет: QUIC через SOCKS-прокси
 * Chrome не пускает, а WebRTC-UDP идёт мимо прокси — остаток, docs/SECURITY.md «SSRF по DNS».
 */
import { type LookupFunction, type Socket, connect, createServer, isIPv6 } from "node:net";
import { type HostLookup, createLogger, urlHostname } from "@jarvis/shared";
import { HostJudge } from "./jarvis-browser-proxy-judge.js";
import { REP, readConnectTarget, reply } from "./jarvis-browser-socks5.js";

const log = createLogger("actuator:jarvis-browser:proxy");

export interface ProxyBlock {
  /** Хост в записи гарда (`urlHostname`): нижний регистр, без скобок и хвостовой точки. */
  host: string;
  port: number;
  reason: "private" | "unresolved";
}

export interface PinProxyOpts {
  /** Резолвер суда (DI стенда); нет → системный getaddrinfo. */
  lookup?: HostLookup;
  /** ТОЛЬКО стенд: проверенный адрес → куда реально звонить (TEST-NET → 127.0.0.1). Суд — до подмены. */
  mapAddress?: (address: string) => string;
  onBlock?: (b: ProxyBlock) => void;
}

export interface PinProxy {
  port: number;
  /** Последние блоки (диагностика, стенд). */
  readonly blocked: ProxyBlock[];
  close(): void;
}

const HANDSHAKE_MS = 10_000;
/** Сколько ждём суда (слот + резолв) — не дольше таймаута SOCKS-подключения Chrome; дальше клиент не ждёт. */
const JUDGE_WAIT_MS = 35_000;
const CONNECT_MS = 15_000;
/** Имя-заглушка: net.connect зовёт НАШ lookup (он отдаёт проверенные адреса), а не DNS. */
const PINNED = "pinned.jarvis.invalid";

/** Флаги Chrome: весь трафик — через прокси, включая loopback (иначе литерал 127.0.0.1 шёл бы мимо). */
export function pinProxyArgs(port: number): string[] {
  return [`--proxy-server=socks5://127.0.0.1:${port}`, "--proxy-bypass-list=<-loopback>"];
}

/** Проверенные адреса → lookup сокета (Node сам выберет семейство — happy eyeballs среди НИХ). */
const pinnedLookup = (addrs: string[]): LookupFunction => (_host, o, cb) => {
  const all = addrs.map((address) => ({ address, family: isIPv6(address) ? 6 : 4 }));
  if (o.all) cb(null, all);
  else cb(null, all[0]!.address, all[0]!.family);
};

async function serve(sock: Socket, opts: PinProxyOpts, judge: HostJudge, blocked: ProxyBlock[]): Promise<void> {
  const target = await readConnectTarget(sock);
  if (!target) return;
  sock.setTimeout(JUDGE_WAIT_MS, () => sock.destroy()); // очередь суда не держит молчащий сокет вечно
  const host = urlHostname(target.raw); // как у гарда: имя из URL в той же канонической записи (IPv6 — сжатая)
  const v = await judge.judge(host, () => !sock.destroyed);
  if (sock.destroyed) return; // Chrome бросил запрос, пока шёл суд
  if (!v.ok) {
    const b: ProxyBlock = { host: host || target.raw.slice(0, 80), port: target.port, reason: v.reason };
    blocked.push(b);
    if (blocked.length > 50) blocked.shift();
    log.warn(v.reason === "private" ? "B-14: соединение во внутреннюю сеть отклонено прокси" : "B-14: соединение отклонено — DNS не подтвердил адрес", { ...b, ...v });
    try {
      opts.onBlock?.(b);
    } catch {
      /* подписчик не срывает ответ Chrome */
    }
    return void sock.end(reply(v.reason === "private" ? REP.ruleset : REP.unreachable));
  }
  const addrs = v.addresses.map((a) => opts.mapAddress?.(a) ?? a);
  // Попытка на адрес 1,5 с (не 250 мс по умолчанию: живой, но далёкий первый адрес не бросаем); keepalive — как у Chrome.
  const up = connect({ host: PINNED, port: target.port, lookup: pinnedLookup(addrs), autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1500, keepAlive: true, keepAliveInitialDelay: 45_000 });
  let live = false;
  up.setTimeout(CONNECT_MS, () => up.destroy(new Error("socks: таймаут подключения")));
  up.on("error", () => (live ? sock.destroy() : sock.end(reply(REP.refused))));
  sock.on("close", () => up.destroy());
  up.once("connect", () => {
    live = true;
    up.setTimeout(0);
    sock.setTimeout(0); // дальше — долгоживущий канал (wss webK), простой не рвём
    up.setNoDelay(true);
    sock.setNoDelay(true);
    sock.write(reply(REP.ok));
    sock.pipe(up);
    up.pipe(sock);
  });
}

/** Поднять прокси на 127.0.0.1:<свободный>. Ошибка старта — бросок (браузер без пиннинга не запускаем). */
export function startPinProxy(opts: PinProxyOpts = {}): Promise<PinProxy> {
  const blocked: ProxyBlock[] = [];
  const judge = new HostJudge({ lookup: opts.lookup });
  const socks = new Set<Socket>();
  const srv = createServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => sock.destroy()); // необработанный error сокета — крах главного процесса Electron
    sock.setTimeout(HANDSHAKE_MS, () => sock.destroy());
    serve(sock, opts, judge, blocked).catch(() => sock.destroy());
  });
  return new Promise<PinProxy>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      srv.off("error", reject).on("error", (e) => log.warn("B-14: ошибка прокси пиннинга", e.message));
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      const close = (): void => {
        srv.close();
        for (const s of socks) s.destroy();
      };
      if (port) return resolve({ port, blocked, close });
      close();
      reject(new Error("прокси пиннинга: нет порта"));
    });
  });
}
