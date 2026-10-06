import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { FakeDesktop } from "./contracts-desktop.js";

// ───────────────────────── LabServer ─────────────────────────

export interface LabServerOptions {
  /** Каталог прогона (ASCII, вне репозитория). По умолчанию %TEMP%/jarvis-lab/<id>. */
  dir?: string;
  /** 0/не задан → свободный порт из 8811..8899. НИКОГДА 8787. */
  port?: number;
  /** Мозг: "off" — LLM выключен (STT mock, ответ-заглушка), "real" — по подписке (тратит общий лимит!), "scripted" — сценарный (см. bench). */
  brain?: "off" | "scripted" | "real";
  /** Дополнительные env-переменные процесса сервера (поверх лабораторных). */
  env?: Record<string, string>;
  /** Аудио: STT реальный (Deepgram, нужен ключ) или mock. */
  stt?: "mock" | "deepgram";
}

export interface LabServer {
  id: string;
  url: string; // ws://127.0.0.1:<port>/ws
  httpUrl: string; // http://127.0.0.1:<port>
  port: number;
  dir: string;
  dataDir: string;
  devToken: string;
  pid: number;
  /** Хвост лога процесса (stdout+stderr) и JSONL-лога сервера. */
  logTail(lines?: number): string;
  /** Строки metrics.jsonl (разобранные). */
  metrics(): Array<Record<string, unknown>>;
  health(): Promise<{ ok: boolean; sessions: number }>;
  stop(): Promise<void>;
}

// ───────────────────────── LabClient ─────────────────────────

/** Политика ответа на вопрос §14 (user.confirm.request). */
export type ConfirmPolicy =
  | "yes"
  | "no"
  | "expire"
  | "undelivered"
  | Array<"yes" | "no" | "expire" | "undelivered">
  | ((summary: string, kind: string, n: number) => "yes" | "no" | "expire" | "undelivered");

export interface LabClientOptions {
  server: LabServer;
  desktop: FakeDesktop;
  /** UUID-токен → своя партиция userId (изоляция памяти). По умолчанию случайный. */
  token?: string;
  /** Имя клиента для сервера. НЕ должно совпадать с dev-шаблоном /cmd|test|driver|qa|smoke|probe|bench|script/i, если нужна полная (не dev) сессия. По умолчанию "lab-1.0". */
  clientVersion?: string;
  confirm?: ConfirmPolicy;
  /** Искусственные отказы/задержки на конкретные виды команд (тесты устойчивости). */
  faults?: Array<{ kind: string; mode: "error" | "timeout" | "drop_socket" | "slow"; ms?: number; times?: number }>;
}

export interface ChatLine {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface TurnResult {
  utterance: string;
  ok: boolean;
  /** Почему закончили ждать: idle сервера | задача завершена | таймаут ожидания. */
  ended: "idle" | "task_done" | "timeout";
  ms: number;
  chat: ChatLine[];
  /** Последняя реплика ассистента (текст). */
  answer: string;
  /** Что озвучено (склеенный текст speak.chunk, если сервер отдал; иначе пусто) и сколько чанков. */
  speech: { chunks: number; bytes: number; audioMime?: string };
  actions: Array<{ cmd: ActionCommand; result: ActionResult; ms: number }>;
  confirms: Array<{ summary: string; kind: string; answer: string }>;
  tasks: Array<{ taskId: string; state: string; title?: string }>;
  cards: Array<{ title?: string; markdown: string }>;
  states: string[]; // последовательность client.state
  serverErrors: string[];
}

export interface LabClient {
  readonly sessionId: string;
  readonly userToken: string;
  /** Текстовый ход (dev.text): как реплика владельца. */
  say(text: string, opts?: { timeoutMs?: number; waitTasks?: boolean }): Promise<TurnResult>;
  /** Сырые события с начала сессии (для инспекции). */
  events(): Array<{ at: number; dir: "in" | "out"; type: string; payload: unknown }>;
  send(type: string, payload: unknown): void;
  close(): Promise<void>;
}
