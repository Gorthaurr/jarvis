/**
 * Transport — постоянный WebSocket-клиент к серверу (§5).
 *
 * Обязанности (§5):
 *   - подключение к ws://HOST:PORT/ws, отправка client.hello с PROTOCOL_VERSION;
 *   - heartbeat ping/pong каждые HEARTBEAT_INTERVAL_MS; два пропуска (HEARTBEAT_MAX_MISSES) -> реконнект;
 *   - реконнект с экспоненциальным backoff и resumeSessionId (продолжение сессии);
 *   - доисполнение in-flight команд: команды, по которым ещё не отправлен action.result,
 *     переотправляются после реконнекта (точнее — их результаты, как только готовы);
 *   - маппинг action.command -> dispatch(actuators) -> отправка action.result (корреляция по commandId);
 *   - эмит входящих server->client сообщений наружу (на main) для проброса в renderer.
 *
 * Версия протокола: несовпадение мажора -> сервер шлёт error(version_mismatch);
 * клиент НЕ переподключается молча, а сигналит «требуется обновление» (§5).
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  makeEnvelope,
  isEnvelope,
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSES,
  DEFAULT_ACTION_TIMEOUT_MS,
} from "@jarvis/protocol";
import type {
  Envelope,
  ActionCommand,
  ActionResult,
  ServerHello,
  Transcript,
  SpeakChunk,
  ProactiveNudge,
  ConfirmRequest,
  TaskStatus,
  DisplayCard,
  ProtocolError,
  Hello,
  DevText,
  ClientState,
} from "@jarvis/protocol";
import { backoffMs, createLogger } from "@jarvis/shared";

const log = createLogger("transport");

/** Конфиг транспорта (host/port/токен из env/настроек). */
export interface TransportConfig {
  host: string;
  port: number;
  /** dev-токен авторизации (на M0 произвольный; сервер валидирует позже). */
  token: string;
  /** версия клиента для Hello.clientVersion. */
  clientVersion: string;
}

/**
 * Исполнитель команд: внедряется снаружи (actuators.dispatch), чтобы transport
 * не зависел от деталей актуаторов. Возвращает ActionResult (с проставленным commandId).
 */
export type CommandExecutor = (commandId: string, cmd: ActionCommand) => Promise<ActionResult>;

/** События, которые transport эмитит наружу (потребляет main -> renderer). */
export interface TransportEvents {
  connected: [ServerHello];
  disconnected: [{ reason: string }];
  transcript: [Transcript];
  speak: [SpeakChunk];
  nudge: [ProactiveNudge];
  confirmRequest: [ConfirmRequest];
  taskStatus: [TaskStatus];
  display: [DisplayCard];
  protocolError: [ProtocolError];
  /** изменение «связности» для индикатора в UI. */
  link: [{ online: boolean }];
}

/**
 * Запись о команде «в полёте» (§5): получена, но action.result ещё не подтверждён сервером.
 * На M0 «подтверждение» = успешная отправка по сокету; при дисконнекте до отправки —
 * результат буферизуется и до-отправляется после реконнекта (at-least-once).
 */
interface InFlight {
  commandId: string;
  command: ActionCommand;
  /** готовый результат, ждущий отправки (если команда уже исполнена при оффлайне). */
  pendingResult?: ActionResult;
}

export class Transport extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly cfg: TransportConfig;
  private readonly executor: CommandExecutor;

  private sessionId: string | undefined; // для resume (§5)
  private closedByUser = false;
  private reconnectAttempt = 0;

  // heartbeat
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;

  // in-flight (§5): commandId -> запись
  private readonly inFlight = new Map<string, InFlight>();
  // результаты, не доставленные из-за оффлайна — переотправляются после connected.
  private readonly outbox: ActionResult[] = [];

  constructor(cfg: TransportConfig, executor: CommandExecutor) {
    super();
    this.cfg = cfg;
    this.executor = executor;
  }

  /** Типобезопасный emit (узкий перегруз поверх EventEmitter). */
  override emit<K extends keyof TransportEvents>(event: K, ...args: TransportEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof TransportEvents>(
    event: K,
    listener: (...args: TransportEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  get url(): string {
    return `ws://${this.cfg.host}:${this.cfg.port}/ws`;
  }

  /** Старт: подключиться и держать соединение живым. */
  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  /** Корректное завершение (выход из приложения). */
  stop(): void {
    this.closedByUser = true;
    this.clearHeartbeat();
    this.ws?.close(1000, "client shutdown");
    this.ws = null;
  }

  /** Отправить dev-текст пользователя на сервер (M0 поток, §17). */
  sendDevText(text: string): void {
    const env = makeEnvelope<DevText>("dev.text", { text });
    this.send(env);
  }

  /** Сообщить серверу состояние клиента (idle/listening/thinking/speaking). */
  sendClientState(state: ClientState): void {
    this.send(makeEnvelope("client.state", { state }));
  }

  /** Отправить результат подтверждения пользователя (§14). */
  sendConfirmResult(requestId: string, approved: boolean, revision?: string): void {
    this.send(makeEnvelope("user.confirm.result", { requestId, approved, revision }));
  }

  // ── соединение ────────────────────────────────────────────────

  private connect(): void {
    log.info(`connect -> ${this.url} (attempt ${this.reconnectAttempt})`);
    this.emit("link", { online: false });

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      log.info("сокет открыт, шлём client.hello");
      this.reconnectAttempt = 0;
      this.sendHello();
      this.startHeartbeat();
      // Доисполнение in-flight (§5): переотправляем буфер результатов.
      this.flushOutbox();
    });

    ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw));

    ws.on("pong", () => {
      this.missedPongs = 0;
    });

    ws.on("close", (code, reason) => {
      const why = `close ${code} ${reason?.toString() || ""}`.trim();
      log.warn(`сокет закрыт: ${why}`);
      this.clearHeartbeat();
      this.emit("disconnected", { reason: why });
      this.emit("link", { online: false });
      this.scheduleReconnect();
    });

    ws.on("error", (e) => {
      log.error(`ошибка сокета: ${e instanceof Error ? e.message : String(e)}`);
      // close прилетит следом; реконнект планируется там.
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    const delay = backoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    log.info(`реконнект через ${delay} мс (resume=${this.sessionId ?? "—"})`);
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private sendHello(): void {
    const hello: Hello = {
      token: this.cfg.token,
      clientVersion: this.cfg.clientVersion,
      protocolVersion: PROTOCOL_VERSION,
      resumeSessionId: this.sessionId, // §5: продолжить сессию после реконнекта
    };
    this.send(makeEnvelope<Hello>("client.hello", hello));
  }

  // ── heartbeat (§5) ────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.missedPongs = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.missedPongs >= HEARTBEAT_MAX_MISSES) {
        log.warn(`пропущено ${this.missedPongs} pong подряд -> терминируем сокет`);
        this.ws.terminate(); // -> close -> scheduleReconnect
        return;
      }
      this.missedPongs += 1; // обнулится на 'pong'
      // ws-уровневый ping (фрейм 0x9). Сервер обязан ответить pong.
      this.ws.ping();
      // Дублируем протокольный ping-конверт — на случай, если сервер слушает прикладной heartbeat.
      this.send(makeEnvelope("ping", {}));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── приём ─────────────────────────────────────────────────────

  private onMessage(raw: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      log.warn("получен не-JSON кадр, игнор");
      return;
    }
    if (!isEnvelope(parsed)) {
      log.warn("кадр не похож на Envelope, игнор");
      return;
    }
    const env = parsed as Envelope;

    switch (env.type) {
      case "server.hello": {
        const hello = env.payload as ServerHello;
        this.sessionId = hello.sessionId; // запоминаем для resume
        log.info(`server.hello: session=${hello.sessionId} resumed=${hello.resumed}`);
        this.emit("connected", hello);
        this.emit("link", { online: true });
        break;
      }
      case "ping": {
        // прикладной ping от сервера -> отвечаем pong-конвертом.
        this.send(makeEnvelope("pong", {}));
        break;
      }
      case "pong": {
        this.missedPongs = 0;
        break;
      }
      case "action.command": {
        void this.handleActionCommand(env as Envelope<ActionCommand & { timeoutMs?: number }>);
        break;
      }
      case "transcript":
        this.emit("transcript", env.payload as Transcript);
        break;
      case "speak.chunk":
        this.emit("speak", env.payload as SpeakChunk);
        break;
      case "proactive.nudge":
        this.emit("nudge", env.payload as ProactiveNudge);
        break;
      case "user.confirm.request":
        this.emit("confirmRequest", env.payload as ConfirmRequest);
        break;
      case "task.status":
        this.emit("taskStatus", env.payload as TaskStatus);
        break;
      case "ui.display":
        this.emit("display", env.payload as DisplayCard);
        break;
      case "error": {
        const pe = env.payload as ProtocolError;
        log.error(`protocol error: ${pe.code} ${pe.message}`);
        this.emit("protocolError", pe);
        // version_mismatch -> НЕ реконнектим молча: сигналим «требуется обновление».
        if (pe.code === "version_mismatch") this.closedByUser = true;
        break;
      }
      default:
        log.debug(`необработанный тип сообщения: ${env.type}`);
    }
  }

  /**
   * Обработка action.command (§5): корреляция по envelope.id = commandId.
   * Регистрируем in-flight, исполняем актуатором (с дедлайном timeoutMs), шлём action.result.
   */
  private async handleActionCommand(
    env: Envelope<ActionCommand & { timeoutMs?: number }>,
  ): Promise<void> {
    const commandId = env.id;
    const { timeoutMs, ...cmd } = env.payload;
    const deadline = timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

    // Дедуп: если уже исполняем эту команду — не дублируем (at-least-once доставка команд).
    if (this.inFlight.has(commandId)) {
      log.warn(`повторный action.command ${commandId} — игнор (уже in-flight)`);
      return;
    }
    this.inFlight.set(commandId, { commandId, command: cmd as ActionCommand });

    let result: ActionResult;
    try {
      result = await this.withTimeout(commandId, deadline, this.executor(commandId, cmd as ActionCommand));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result = {
        commandId,
        ok: false,
        error: { code: message === "__timeout__" ? "timeout" : "runtime", message: message === "__timeout__" ? `превышен таймаут ${deadline} мс` : message },
        durationMs: deadline,
      };
    }

    this.deliverResult(result);
  }

  /** Гонка исполнения с дедлайном (§5: timeoutMs обязателен в команде). */
  private withTimeout(_commandId: string, ms: number, p: Promise<ActionResult>): Promise<ActionResult> {
    let t: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error("__timeout__")), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t)) as Promise<ActionResult>;
  }

  /**
   * Доставить action.result. Если сокет жив — отправляем и снимаем in-flight.
   * Если оффлайн — кладём результат в outbox и помечаем in-flight как pending,
   * чтобы переотправить после реконнекта (§5 доисполнение in-flight).
   */
  private deliverResult(result: ActionResult): void {
    const env = makeEnvelope<ActionResult>("action.result", result, undefined, Date.now());
    if (this.isOpen()) {
      this.rawSend(env);
      this.inFlight.delete(result.commandId);
    } else {
      log.warn(`оффлайн: буферизуем action.result ${result.commandId} до реконнекта`);
      const rec = this.inFlight.get(result.commandId);
      if (rec) rec.pendingResult = result;
      this.outbox.push(result);
    }
  }

  /** Переотправить накопленные результаты после восстановления связи (§5). */
  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    log.info(`flush outbox: ${this.outbox.length} отложенных action.result`);
    while (this.outbox.length > 0) {
      const r = this.outbox.shift();
      if (!r) break;
      this.rawSend(makeEnvelope<ActionResult>("action.result", r, undefined, Date.now()));
      this.inFlight.delete(r.commandId);
    }
  }

  // ── низкоуровневая отправка ───────────────────────────────────

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Отправить конверт; при оффлайне молча дропаем (heartbeat/ping/state не критичны). */
  private send(env: Envelope): void {
    if (!this.isOpen()) return;
    this.rawSend(env);
  }

  private rawSend(env: Envelope): void {
    try {
      this.ws?.send(JSON.stringify(env));
    } catch (e) {
      log.error(`не удалось отправить ${env.type}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
