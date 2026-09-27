/**
 * B-14 (W4): SSRF-гард НАВИГАЦИИ невидимого браузера Джарвиса.
 *
 * Сервер проверял только ЯВНЫЙ url (web_open), а браузер залогинен и ходит по редиректам: 302 на 192.168.0.1,
 * клик по подложенной ссылке `http://127.0.0.1:…`, `target=_blank` — и страница роутера/метаданные облака уезжали
 * модели через web_read. Теперь КАЖДЫЙ запрос документа (верхний фрейм, iframe, новая вкладка) браузер ставит на паузу
 * (`Fetch.enable` на соединении уровня БРАУЗЕРА — оно видит и всплывающие вкладки), и приватный хост (одно правило
 * с сервером — `@jarvis/shared` isPrivateHttpUrl) получает `Fetch.failRequest(BlockedByClient)` ДО запроса в сеть.
 *
 * Журнал блокировок — чтобы open()/act() честно сказали «переход во внутреннюю сеть заблокирован», а не отдали
 * текст страницы ошибки Chrome как содержимое сайта.
 *
 * B-14 (DNS, 27.09): судим не только ИМЯ, но и ОТВЕТ DNS (`checkHostPublic`): `localtest.me`/`127.0.0.1.nip.io`
 * (→ 127.0.0.1) проходили по имени, и браузер реально ходил на dev-HTTP сервера. Любой приватный адрес ответа → отказ;
 * имя не разрешилось/DNS молчит → тоже отказ (без проверки адреса не пускаем). DNS rebinding (Chrome резолвит сам
 * ПОСЛЕ нас) закрывает пиннинг-прокси (jarvis-browser-proxy.ts): его блок на host:port недавно ОТПУЩЕННОГО здесь
 * документа — `proxyBlocked` — ложится в тот же журнал с кадром перехода, и open()/read() говорят честно.
 */
import { type HostLookup, checkHostPublic, createLogger, urlHostname } from "@jarvis/shared";
import type { CdpConn } from "./cdp-conn.js";
import type { ProxyBlock } from "./jarvis-browser-proxy.js";

const log = createLogger("actuator:jarvis-browser:nav-guard");

export interface BlockedNav {
  seq: number;
  host: string;
  frameId?: string;
  /** private — имя/ответ DNS ведут во внутреннюю сеть; unresolved — адрес не проверить (DNS не разрешил/молчит). */
  reason: "private" | "unresolved";
}

const DOCUMENT_PATTERN = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];
/** Сколько помним отпущенный документ: подключение через прокси идёт сразу за ним (суд прокси ≤ 3 с). */
const RELEASED_TTL_MS = 15_000;

/** Ключ «хост:порт» в записи прокси (хост — `urlHostname`, порт по схеме). */
function hostPort(url: string): string {
  try {
    const u = new URL(url);
    return `${urlHostname(url)}:${u.port || (u.protocol === "https:" ? 443 : 80)}`;
  } catch {
    return "";
  }
}

export class NavGuard {
  private readonly journal: BlockedNav[] = [];
  private readonly released: Array<{ key: string; frameId?: string; at: number }> = [];
  private seq = 0;

  /** lookup — DI стенда (таблица имён); нет → системный DNS. */
  constructor(
    private readonly conn: CdpConn,
    private readonly lookup?: HostLookup,
  ) {}

  /** Включить перехват. Без него браузер НЕ используется (вызывающий перезапускает — fail-closed). */
  async start(): Promise<void> {
    this.conn.on("Fetch.requestPaused", (p) => void this.onPaused(p));
    await this.conn.send("Fetch.enable", { patterns: DOCUMENT_PATTERN });
  }

  get dead(): boolean {
    return this.conn.dead;
  }

  close(): void {
    this.conn.close();
  }

  private async onPaused(p: Record<string, unknown>): Promise<void> {
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    const req = p.request && typeof p.request === "object" ? (p.request as { url?: unknown }) : {};
    const url = typeof req.url === "string" ? req.url : "";
    if (!requestId) return;
    // about:blank/data:/chrome-error — сети нет, судить нечего; http(s) — по имени И по ответу DNS.
    const host = urlHostname(url);
    const frameId = typeof p.frameId === "string" ? p.frameId : undefined;
    const verdict = /^https?:\/\//iu.test(url) ? await checkHostPublic(host, { lookup: this.lookup }) : null;
    if (!verdict || verdict.ok) {
      if (verdict) this.release(url, frameId);
      await this.conn.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
      return;
    }
    this.record({ host, frameId, reason: verdict.reason });
    log.warn(verdict.reason === "private" ? "B-14: переход на внутренний адрес заблокирован" : "B-14: переход заблокирован — DNS не подтвердил адрес", { host, ...verdict });
    await this.conn.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  }

  private record(b: Omit<BlockedNav, "seq">): void {
    this.journal.push({ seq: ++this.seq, ...b });
    if (this.journal.length > 50) this.journal.shift();
  }

  private release(url: string, frameId?: string): void {
    const now = Date.now();
    while (this.released.length && (now - this.released[0]!.at > RELEASED_TTL_MS || this.released.length > 100)) this.released.shift();
    this.released.push({ key: hostPort(url), frameId, at: now });
  }

  /**
   * Блок пиннинг-прокси. Совпал с недавно отпущенным документом (тот же host:port) — это сорванный ПЕРЕХОД: запись
   * журнала с его кадром. Нет — подресурс (fetch/img/wss): только журнал прокси, act() не пугаем чужим блоком.
   */
  proxyBlocked(b: ProxyBlock): boolean {
    const key = `${b.host}:${b.port}`;
    const now = Date.now();
    for (let i = this.released.length - 1; i >= 0; i--) {
      const r = this.released[i]!;
      if (r.key !== key || now - r.at > RELEASED_TTL_MS) continue;
      this.record({ host: b.host, frameId: r.frameId, reason: b.reason });
      log.warn("B-14: переход сорван пиннинг-прокси — адрес при подключении не тот, что при проверке (rebinding)", { ...b });
      return true;
    }
    return false;
  }

  /** Метка «до действия»: блокировки ПОСЛЕ неё вернёт since(). */
  mark(): number {
    return this.seq;
  }

  /** Заблокированные переходы после метки (все фреймы и вкладки). */
  since(mark: number): BlockedNav[] {
    return this.journal.filter((b) => b.seq > mark);
  }
}

/** Честный текст о заблокированном переходе (хост — имя из URL: только [a-z0-9.:-], делимитер не разорвать). */
export function blockedNavText(blocked: BlockedNav[]): string {
  const hosts = (reason: BlockedNav["reason"]) => [...new Set(blocked.filter((b) => b.reason === reason).map((b) => b.host))].slice(0, 3).join(", ");
  const parts: string[] = [];
  const priv = hosts("private");
  if (priv) parts.push(`переход на внутренний адрес (${priv}) заблокирован — адрес ведёт в локальную сеть (напрямую, редиректом, ссылкой или именем, которое DNS отдаёт как внутренний IP); туда не хожу и оттуда не читаю`);
  const unresolved = hosts("unresolved");
  if (unresolved) parts.push(`переход на ${unresolved} не выполнен — адрес не прошёл проверку DNS (имя не разрешилось или DNS не ответил); без проверки адреса браузер Джарвиса не пускаю`);
  return parts.join("; ");
}
