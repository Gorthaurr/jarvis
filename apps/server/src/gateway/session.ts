/**
 * Session — серверное состояние одного клиентского соединения (§5).
 *
 * Отвечает за:
 *  - отправку конвертов в WS;
 *  - корреляцию ActionCommand ↔ ActionResult по commandId (in-flight Map);
 *  - таймауты действий (§5: нет result дольше timeoutMs → {ok:false,error.code:"timeout"});
 *  - корреляцию ConfirmRequest ↔ ConfirmResult (§14).
 *
 * Session НЕ знает о Fastify/ws-конкретике: ws задаётся минимальным интерфейсом,
 * чтобы Session был тестируемым в изоляции и переживал реконнект (rebind).
 */
import {
  type ActionCommand,
  type ActionResult,
  type ConfirmRequest,
  type ConfirmResult,
  DEFAULT_ACTION_TIMEOUT_MS,
  type Envelope,
  type MessageType,
  makeEnvelope,
} from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";

/** Минимальный контракт сокета, который нужен Session (подмена в тестах). */
export interface SessionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** WebSocket.OPEN === 1 по спецификации; держим локально, чтобы не тащить ws в типы. */
const WS_OPEN = 1;

interface PendingAction {
  resolve(result: ActionResult): void;
  timer: ReturnType<typeof setTimeout>;
  command: ActionCommand;
}

interface PendingConfirm {
  resolve(result: ConfirmResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export class Session {
  readonly sessionId: string;
  readonly userId: string;
  /** Текущий сокет; меняется при реконнекте (§5, resume). */
  private socket: SessionSocket;
  private readonly log: Logger;

  /** Команды, ждущие ActionResult, по commandId. */
  private readonly inFlight = new Map<string, PendingAction>();
  /** Запросы подтверждения, ждущие ConfirmResult, по requestId. */
  private readonly pendingConfirms = new Map<string, PendingConfirm>();

  /** Последний пройденный heartbeat (для диагностики/реконнекта). */
  lastPongAt = Date.now();
  /** Жива ли сессия (false после close — in-flight отклоняются disconnected). */
  private alive = true;
  /**
   * Сессионно-скоупленные синглтоны, ПЕРЕЖИВАЮЩИЕ resume (§5): рабочая память диалога и пр. Раньше
   * makeSessionContext создавал WorkingMemory заново на КАЖДОМ коннекте → reconnect терял всю историю
   * («забыл, о чём говорили»). Теперь то, что лежит здесь, переиспользуется при rebind.
   */
  private readonly scopedStore = new Map<string, unknown>();

  /**
   * H8: коллбэк финальной очистки сессии — выполняется ТОЛЬКО при РЕАЛЬНОМ удалении (teardown из
   * registry.remove/teardownAll), НЕ на обрыве сокета в resume-grace. Сюда makeSessionContext вешает
   * отмену фоновых §20-задач: раньше её звали синхронно на ws-close → reconnect в 120с grace-окне
   * находил задачу уже УБИТОЙ (результат потерян), хотя память цела. Теперь задача живёт весь grace и
   * снимается лишь когда сессия действительно уходит. Один слот (перезапись при rebind — актуален
   * последний ctx). */
  private onTeardownCb?: () => void;

  constructor(sessionId: string, userId: string, socket: SessionSocket) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.socket = socket;
    this.log = createLogger(`session:${sessionId.slice(0, 8)}`);
  }

  /**
   * Сессионно-скоупленный синглтон (§5 resume): создать один раз и переиспользовать при reconnect.
   * makeSessionContext берёт через это рабочую память диалога — она переживает rebind, история не теряется.
   * Session не знает типа значения (хранит unknown) — слой памяти не протекает в gateway.
   */
  scoped<T>(key: string, factory: () => T): T {
    if (!this.scopedStore.has(key)) this.scopedStore.set(key, factory());
    return this.scopedStore.get(key) as T;
  }

  /**
   * H8: зарегистрировать коллбэк финальной очистки (запускается в teardown — реальное удаление сессии,
   * а НЕ обрыв сокета в resume-grace). makeSessionContext вешает сюда отмену фоновых задач. Перезапись
   * при reconnect (актуален последний ctx). */
  onTeardown(cb: () => void): void {
    this.onTeardownCb = cb;
  }

  /** Переподключить сессию к новому сокету (resume, §5). In-flight сохраняются. */
  rebind(socket: SessionSocket): void {
    this.socket = socket;
    this.alive = true;
    this.lastPongAt = Date.now();
    this.log.info("сессия перепривязана к новому сокету (resume)");
  }

  /**
   * Привязана ли сессия ИМЕННО к этому сокету (§5). Нужно, чтобы отличить «закрылся старый сокет
   * после resume» (сессию уже забрало новое соединение — трогать нельзя) от «закрылось текущее
   * соединение» (можно сносить сессию). Без этой проверки close старого сокета убивал живую
   * возобновлённую сессию (teardown + отклонение in-flight + снятие фоновых задач).
   */
  isBoundTo(socket: SessionSocket): boolean {
    return this.socket === socket;
  }

  /** Низкоуровневая отправка конверта. */
  send<T>(type: MessageType, payload: T, id?: string): void {
    if (!this.alive || this.socket.readyState !== WS_OPEN) {
      this.log.warn("попытка отправки в закрытый сокет", { type });
      return;
    }
    const env: Envelope<T> = makeEnvelope(type, payload, id);
    try {
      this.socket.send(JSON.stringify(env));
    } catch (e) {
      this.log.error("ошибка отправки в WS", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Отправить ActionCommand и дождаться ActionResult (§5).
   * commandId = envelope.id; payload несёт timeoutMs.
   * По истечении timeoutMs — резолв синтетическим {ok:false,error.code:"timeout"}.
   */
  sendAction(command: ActionCommand, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS): Promise<ActionResult> {
    const commandId = this.send_actionEnvelope(command, timeoutMs);

    return new Promise<ActionResult>((resolve) => {
      if (!this.alive) {
        resolve(this.syntheticResult(commandId, "disconnected", "сессия закрыта", 0));
        return;
      }
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.inFlight.delete(commandId);
        this.log.warn("ActionCommand timeout", { commandId, kind: command.kind, timeoutMs });
        resolve(
          this.syntheticResult(commandId, "timeout", `нет result за ${timeoutMs}ms`, Date.now() - startedAt),
        );
      }, timeoutMs);
      // Не держим event loop ради таймера действия.
      if (typeof timer.unref === "function") timer.unref();

      this.inFlight.set(commandId, { resolve, timer, command });
    });
  }

  /** Разрешить ожидающую команду пришедшим ActionResult (вызывает router). */
  resolveAction(result: ActionResult): void {
    const pending = this.inFlight.get(result.commandId);
    if (!pending) {
      // Поздний/дублированный result (уже сняли по таймауту) — игнор, но логируем.
      this.log.debug("ActionResult без in-flight команды", { commandId: result.commandId });
      return;
    }
    clearTimeout(pending.timer);
    this.inFlight.delete(result.commandId);
    pending.resolve(result);
  }

  /**
   * Отправить ConfirmRequest и дождаться решения пользователя (§14).
   * По истечении окна (expiresAt) — auto-deny (§5).
   */
  requestConfirm(request: ConfirmRequest): Promise<ConfirmResult> {
    this.send("user.confirm.request", request, request.requestId);
    const windowMs = Math.max(0, request.expiresAt - Date.now());

    return new Promise<ConfirmResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(request.requestId);
        this.log.info("confirm auto-deny по истечении окна", { requestId: request.requestId });
        resolve({ requestId: request.requestId, approved: false });
      }, windowMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pendingConfirms.set(request.requestId, { resolve, timer });
    });
  }

  /** Разрешить ожидающий confirm пришедшим ConfirmResult (вызывает router). */
  resolveConfirm(result: ConfirmResult): void {
    const pending = this.pendingConfirms.get(result.requestId);
    if (!pending) {
      this.log.debug("ConfirmResult без ожидающего запроса", { requestId: result.requestId });
      return;
    }
    clearTimeout(pending.timer);
    this.pendingConfirms.delete(result.requestId);
    pending.resolve(result);
  }

  /**
   * Закрыть сессию: отклонить все in-flight как disconnected (§5),
   * снять таймеры. Сокет закрывается отдельно вызывающим heartbeat/router.
   */
  teardown(): void {
    this.alive = false;
    for (const [commandId, pending] of this.inFlight) {
      clearTimeout(pending.timer);
      pending.resolve(this.syntheticResult(commandId, "disconnected", "сессия закрыта", 0));
    }
    this.inFlight.clear();
    for (const [, pending] of this.pendingConfirms) {
      clearTimeout(pending.timer);
      pending.resolve({ requestId: "", approved: false });
    }
    this.pendingConfirms.clear();
    // H8: финальная очистка (отмена фоновых §20-задач и т.п.) — ТОЛЬКО здесь, на реальном удалении
    // сессии (grace истёк / shutdown), не на каждом обрыве сокета. Одноразово: снимаем слот, чтобы
    // повторный teardown не выполнял её дважды. Не роняем teardown, если коллбэк бросил.
    const cb = this.onTeardownCb;
    this.onTeardownCb = undefined;
    if (cb) {
      try {
        cb();
      } catch (e) {
        this.log.warn("ошибка финальной очистки сессии (teardown)", e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** Сколько действий сейчас в полёте (диагностика/тесты). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  // ── приватное ──────────────────────────────────────────────

  /** Сформировать и отправить конверт action.command; вернуть commandId. */
  private send_actionEnvelope(command: ActionCommand, timeoutMs: number): string {
    // envelope.id = commandId; payload = команда + timeoutMs (§5).
    const env = makeEnvelope<ActionCommand & { timeoutMs: number }>("action.command", {
      ...command,
      timeoutMs,
    });
    if (this.alive && this.socket.readyState === WS_OPEN) {
      try {
        this.socket.send(JSON.stringify(env));
      } catch (e) {
        this.log.error("ошибка отправки action.command", e instanceof Error ? e.message : String(e));
      }
    } else {
      this.log.warn("action.command в закрытый сокет", { kind: command.kind });
    }
    return env.id;
  }

  private syntheticResult(
    commandId: string,
    code: NonNullable<ActionResult["error"]>["code"],
    message: string,
    durationMs: number,
  ): ActionResult {
    return { commandId, ok: false, error: { code, message }, durationMs };
  }
}
