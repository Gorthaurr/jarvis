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
 * имя не разрешилось/DNS молчит → тоже отказ (без проверки адреса не пускаем). Остаток — DNS rebinding: Chrome
 * резолвит сам ПОСЛЕ нас и может получить другой ответ; закрыть его может только пиннинг адреса (локальный
 * прокси) — почему отложен, см. docs/SECURITY.md «SSRF по DNS».
 */
import { type HostLookup, checkHostPublic, createLogger, urlHostname } from "@jarvis/shared";
import type { CdpConn } from "./cdp-conn.js";

const log = createLogger("actuator:jarvis-browser:nav-guard");

export interface BlockedNav {
  seq: number;
  host: string;
  frameId?: string;
  /** private — имя/ответ DNS ведут во внутреннюю сеть; unresolved — адрес не проверить (DNS не разрешил/молчит). */
  reason: "private" | "unresolved";
}

const DOCUMENT_PATTERN = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];

export class NavGuard {
  private readonly journal: BlockedNav[] = [];
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
    const verdict = /^https?:\/\//iu.test(url) ? await checkHostPublic(host, { lookup: this.lookup }) : null;
    if (!verdict || verdict.ok) {
      await this.conn.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
      return;
    }
    this.journal.push({ seq: ++this.seq, host, frameId: typeof p.frameId === "string" ? p.frameId : undefined, reason: verdict.reason });
    if (this.journal.length > 50) this.journal.shift();
    log.warn("B-14: переход заблокирован", { host, ...verdict });
    await this.conn.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
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
