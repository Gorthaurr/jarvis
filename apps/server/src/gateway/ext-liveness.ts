/**
 * S-12 (W4): допуск на /ext БЕЗ вытеснения живого расширения.
 *
 * Было: каждое новое соединение /ext вызывало `ext.attach`, а мост закрывал прежний сокет — любой локальный
 * процесс (Node шлёт без Origin; Origin он и подделать может) вышибал НАСТОЯЩЕЕ расширение и получал все
 * интенты (куки, Telegram, чтение залогиненных вкладок) + подделывал их исходы.
 *
 * Стало: новичок при подключённом прежнем → протокольный WS-ping прежнему. Пришёл pong за ~1,5 с → прежний
 * ЖИВ, новичка отклоняем (close 4409, WARN). Pong не пришёл / сокет не OPEN / закрылся во время ожидания →
 * прежний мёртв, новичок вытесняет его, как раньше (мост отклоняет висящие запросы как ext_no_reply).
 * Новички сериализуются (два одновременных не пройдут оба). Pong отвечает сетевой стек Chrome — JS
 * service worker'а для этого не нужен. Ограничение: самозванец, успевший подключиться РАНЬШЕ настоящего
 * (сервер стартовал, Chrome ещё нет), с поддельным Origin удержит канал — это граница модели угроз loopback.
 */
import type { Logger } from "@jarvis/shared";

export const EXT_PING_TIMEOUT_MS = 1_500;
/** Код закрытия «канал занят живым расширением» (4000-4999 — прикладной диапазон RFC 6455). */
export const EXT_BUSY_CLOSE = 4409;

/** Минимальный контракт сокета для проверки живости (ws.WebSocket / @fastify/websocket v11). */
export interface PingableWs {
  readonly readyState?: number;
  ping?(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong" | "close", cb: () => void): void;
}

interface Tracked {
  ws: PingableWs;
  closed: boolean;
  waiters: Array<(alive: boolean) => void>;
}

const OPEN = 1;

export class ExtAdmission {
  private current: Tracked | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: Logger,
    private readonly pingTimeoutMs = EXT_PING_TIMEOUT_MS,
  ) {}

  /**
   * Решить судьбу новичка. Допущен → `onAdmit()` вызывается СИНХРОННО внутри решения (между проверкой
   * «новичок ещё жив» и подключением к мосту нет окна для его close); отклонён → сокет закрыт 4409.
   */
  admit(ws: PingableWs, onAdmit: () => void): Promise<boolean> {
    const me = this.track(ws);
    const run = this.queue.then(() => this.decide(me, onAdmit));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private track(ws: PingableWs): Tracked {
    const t: Tracked = { ws, closed: false, waiters: [] };
    ws.on("pong", () => this.settle(t, true));
    ws.on("close", () => {
      t.closed = true;
      this.settle(t, false);
      if (this.current === t) this.current = null;
    });
    return t;
  }

  private settle(t: Tracked, alive: boolean): void {
    const ws = t.waiters.splice(0);
    for (const w of ws) w(alive);
  }

  private async decide(me: Tracked, onAdmit: () => void): Promise<boolean> {
    const prev = this.current;
    if (prev && prev !== me && (await this.alive(prev))) {
      this.log.warn("§sec S-12: второе подключение к /ext отклонено — живое расширение уже на канале (pong)", {
        code: EXT_BUSY_CLOSE,
      });
      try {
        me.ws.close(EXT_BUSY_CLOSE, "ext busy");
      } catch {
        /* уже закрыт */
      }
      return false;
    }
    if (me.closed) return false; // новичок ушёл, пока проверяли прежнего — подключать нечего
    if (prev && prev !== me) this.log.warn("/ext: прежнее соединение не ответило на ping — вытесняем его новым");
    this.current = me;
    onAdmit();
    return true;
  }

  /** Жив ли сокет: OPEN и отвечает pong за pingTimeoutMs. */
  private alive(t: Tracked): Promise<boolean> {
    if (t.closed || (t.ws.readyState !== undefined && t.ws.readyState !== OPEN) || typeof t.ws.ping !== "function") {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), this.pingTimeoutMs);
      t.waiters.push(finish);
      try {
        t.ws.ping?.();
      } catch {
        finish(false);
      }
    });
  }
}
