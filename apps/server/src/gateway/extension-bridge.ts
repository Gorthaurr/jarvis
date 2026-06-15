/**
 * Мост к браузерному расширению «Jarvis Web Hands» (§6 — невидимые руки в браузере).
 *
 * Расширение живёт в Chrome пользователя (его профиль, его логины) и подключается сюда
 * по WS (/ext). Сервер шлёт интенты ({id, type, ...}); расширение исполняет их в фоновой
 * вкладке и отвечает {id, ok, data|error}. request() корреллирует ответ по id с таймаутом.
 *
 * Один процесс — один активный коннект расширения (на текущего пользователя). Декуплен от
 * Fastify минимальным интерфейсом ExtSocket — тестируется без сети.
 */
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";

/** Минимальный контракт сокета расширения (Fastify ws / мок в тестах). */
export interface ExtSocket {
  send(data: string): void;
  close(): void;
}

interface Pending {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionBridge {
  private socket: ExtSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly log: Logger;

  constructor(log: Logger = createLogger("ext-bridge")) {
    this.log = log;
  }

  /** Подключено ли расширение сейчас. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /** Привязать новый коннект расширения (вытесняет прежний). */
  attach(socket: ExtSocket): void {
    if (this.socket && this.socket !== socket) {
      // ВАЖНО: вытесняя старый сокет, отклоняем его ожидающие запросы СРАЗУ — иначе они
      // висят до таймаута на уже мёртвом коннекте (утечка/зависание).
      this.rejectAllPending("расширение переподключилось");
      try {
        this.socket.close();
      } catch {
        /* старый мёртв */
      }
    }
    this.socket = socket;
    this.log.info("расширение подключено (руки в браузере готовы)");
  }

  /** Отвязать коннект (по close). Незавершённые запросы — отклоняем. */
  detach(socket: ExtSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.rejectAllPending("расширение отключилось");
    this.log.info("расширение отключено");
  }

  /** Отклонить все ожидающие запросы (вытеснение/отключение). */
  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Входящее сообщение от расширения: hello / ответ {id, ok, data|error}. */
  handleMessage(raw: string): void {
    let msg: { id?: string; type?: string; ok?: boolean; data?: unknown; error?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      this.log.info("расширение: hello");
      return;
    }
    if (!msg.id) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || "ошибка расширения"));
  }

  /**
   * Отправить интент расширению и дождаться результата (с таймаутом). Если расширение
   * не подключено — сразу ошибка (вызывающий решает, что делать — напр., откат на UI-путь).
   */
  request(intent: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.socket) return Promise.reject(new Error("расширение не подключено"));
    const id = newId();
    const socket = this.socket;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("расширение не ответило за " + timeoutMs + "мс"));
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, ...intent }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Удобный шорткат: отправить сообщение в Telegram через расширение. */
  telegramSend(to: string, text: string): Promise<unknown> {
    return this.request({ type: "telegram.send", to, text }, 45_000);
  }
}
