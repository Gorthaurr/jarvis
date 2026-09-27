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
 * текст страницы ошибки Chrome как содержимое сайта. Ограничение: судим ИМЯ хоста, не DNS (rebinding не ловим).
 */
import { createLogger, isPrivateHttpUrl, urlHostname } from "@jarvis/shared";
import type { CdpConn } from "./cdp-conn.js";

const log = createLogger("actuator:jarvis-browser:nav-guard");

export interface BlockedNav {
  seq: number;
  host: string;
  frameId?: string;
}

const DOCUMENT_PATTERN = [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }];

export class NavGuard {
  private readonly journal: BlockedNav[] = [];
  private seq = 0;

  constructor(private readonly conn: CdpConn) {}

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
    if (!isPrivateHttpUrl(url)) {
      await this.conn.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
      return;
    }
    const host = urlHostname(url);
    this.journal.push({ seq: ++this.seq, host, frameId: typeof p.frameId === "string" ? p.frameId : undefined });
    if (this.journal.length > 50) this.journal.shift();
    log.warn("B-14: переход на внутренний адрес заблокирован", { host });
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
  const hosts = [...new Set(blocked.map((b) => b.host))].slice(0, 3).join(", ");
  return `переход на внутренний адрес (${hosts}) заблокирован — страница пыталась увести браузер Джарвиса в локальную сеть (редирект/ссылка); туда не хожу и оттуда не читаю`;
}
