/**
 * Сообщения протокола клиент↔сервер (§5).
 * Brain эмитит абстрактные команды, клиент мапит на актуаторы.
 */
import type { ActionCommand } from "./actions.js";

/** Общий конверт каждого сообщения. */
export interface Envelope<T = unknown> {
  /** uuid сообщения. Для action.command — это commandId. */
  id: string;
  /** unix ms. */
  ts: number;
  type: MessageType;
  payload: T;
}

export type MessageType =
  // client -> server
  | "client.hello" // Hello — первый кадр после коннекта/реконнекта
  | "dev.text" // DevText — dev-заглушка текстового ввода до голоса (M0); аналог audio.frame
  | "audio.frame" // только dev-заглушка до LiveKit; в проде аудио — ТОЛЬКО WebRTC
  | "audio.vad" // VadEvent
  | "screen.capture.result"
  | "action.result" // ActionResult — обязателен на КАЖДЫЙ ActionCommand, корреляция по commandId
  | "client.state" // ClientStateMsg
  | "user.confirm.result" // ConfirmResult
  | "client.context" // ClientContext — занятость юзера/активное окно, вход salience (§9)
  | "demo.event" // поток UIA-событий при записи демонстрации (§8)
  | "task.control" // TaskControl — управление задачей из UI (кнопка «стоп»/«пауза», §20)
  | "pong"
  // server -> client
  | "server.hello" // ServerHello
  | "speak.chunk" // SpeakChunk — стрим TTS
  | "transcript" // Transcript — для UI/логов
  | "action.command" // ActionCommand; envelope.id = commandId; payload.timeoutMs обязателен
  | "screen.capture.request"
  | "user.confirm.request" // ConfirmRequest
  | "proactive.nudge" // ProactiveNudge — клиент проговаривает сам, ЕСЛИ не истёк
  | "task.status" // TaskStatus — прогресс/смена статуса задачи (§20)
  | "ui.display" // DisplayCard — карточка с подробностями в renderer (§21)
  | "error" // ProtocolError — напр. несовпадение версии
  | "ping";

// ── client -> server ──────────────────────────────────────────

export interface Hello {
  token: string;
  clientVersion: string;
  protocolVersion: number;
  /** Реконнект: продолжить сессию (§5). */
  resumeSessionId?: string;
}

export type ClientState = "idle" | "listening" | "thinking" | "speaking";
export interface ClientStateMsg {
  state: ClientState;
}

export interface VadEvent {
  state: "speech_start" | "speech_end" | "barge_in";
}

/** Текстовый ввод — dev-заглушка до голоса (M0, §17). В проде вход — STT-транскрипт. */
export interface DevText {
  text: string;
}

/** Аудио-кадр — ТОЛЬКО dev-заглушка до подъёма LiveKit (§5). */
export interface AudioFrame {
  /** PCM 16-bit LE. */
  pcm: ArrayBuffer;
  sampleRate: number;
  seq: number;
}

export interface ActionResult {
  /** = envelope.id команды. */
  commandId: string;
  ok: boolean;
  error?: {
    code: "timeout" | "not_found" | "denied" | "disconnected" | "runtime";
    message: string;
  };
  /** напр. {handle, bbox} от ui.ground, stdout от code.run. */
  data?: unknown;
  /** при skill.execute — номер шага. */
  stepIndex?: number;
  durationMs: number;
}

/** Занятость юзера/активное окно — вход salience (§9). */
export interface ClientContext {
  activeApp: string;
  fullscreen: boolean;
  /** микрофон занят communications-приложением (Zoom/Discord/телефония). */
  micBusyByOtherApp: boolean;
  locked: boolean;
}

export interface ConfirmResult {
  requestId: string;
  approved: boolean;
  /** «перепиши короче» → перегенерация → новый confirm (§14, revise-петля). */
  revision?: string;
}

/** UIA-событие при записи демонстрации — роль/имя элемента + действие, НЕ координаты (§8). */
export interface DemoEvent {
  role: string;
  name?: string;
  action: string;
  ts: number;
}

/**
 * Управление задачей из UI (§20): кнопка «стоп»/«пауза»/«продолжить» в renderer,
 * либо структурный дубль голосовой команды. Голосовое «отмени»/«продолжи» классифицирует
 * сервер (Haiku, §20) — этот канал для детерминированных нажатий. taskId опционален:
 * без него действие применяется к активной задаче сессии.
 */
export interface TaskControl {
  action: "cancel" | "pause" | "resume" | "status";
  taskId?: string;
}

// ── server -> client ──────────────────────────────────────────

export interface ServerHello {
  sessionId: string;
  protocolVersion: number;
  resumed: boolean;
}

export interface SpeakChunk {
  audio: ArrayBuffer;
  seq: number;
  last: boolean;
}

export interface Transcript {
  text: string;
  final: boolean;
}

/** Просрочен (now > expiresAt) → клиент НЕ произносит, молча в лог (§9). */
export interface ProactiveNudge {
  text: string;
  reason: string;
  expiresAt: number;
}

/** Истёк → auto-deny (§5). */
export interface ConfirmRequest {
  requestId: string;
  summary: string;
  kind: "send" | "order" | "irreversible";
  expiresAt: number;
}

export type TaskState =
  | "queued"
  | "running"
  | "paused"
  | "waiting_confirm"
  | "done"
  | "failed"
  | "cancelled";

export interface TaskStatus {
  taskId: string;
  state: TaskState;
  summary?: string;
  stepsDone?: number;
  stepsTotal?: number;
}

/** Карточка подробностей в renderer (§21). voice и экран — разные каналы. */
export interface DisplayCard {
  title?: string;
  markdown: string;
}

export interface ScreenCaptureRequest {
  /** опционально: bbox-кроп для context.read(screen). */
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface ScreenCaptureResult {
  /** PNG base64 или ссылка на blob. */
  image: string;
  width: number;
  height: number;
}

export interface ProtocolError {
  code: "version_mismatch" | "unauthorized" | "internal";
  message: string;
}

// ── удобные алиасы конвертов на типы payload ─────────────────

export type ActionCommandEnvelope = Envelope<ActionCommand & { timeoutMs: number }>;
