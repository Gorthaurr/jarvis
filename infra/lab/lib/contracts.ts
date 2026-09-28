/**
 * КОНТРАКТЫ лаборатории Джарвиса (infra/lab). Лаборатория — инструмент АГЕНТА Claude: он сам, без владельца, микрофона и
 * его ПК, гоняет ЛЮБУЮ возможность Джарвиса и видит, что произошло. Здесь только типы: модули лаборатории общаются
 * через них, поэтому строятся независимо. Менять сигнатуры — только вместе с потребителями (см. docs/lab/LAB.md).
 *
 * Слои:
 *   FakeDesktop  — «ПК владельца» с состоянием: окна, UIA-дерево, файлы в песочнице, буфер, аудио, процессы, монитор.
 *                  Отвечает на ActionCommand так, как отвечал бы клиент (формы ActionResult.data — из docs/lab/map/protocol-actions.md).
 *   LabServer    — ИЗОЛИРОВАННЫЙ настоящий сервер (свой порт, PGlite, каталог данных; боевой 8787 не трогает).
 *   LabClient    — настоящий WS-клиент по протоколу: hello/pong/confirm/action.result; ставит действия в FakeDesktop;
 *                  записывает всё, что сервер отправил (чат, озвучку, задачи, вопросы §14).
 *   AudioStand   — WAV → НАСТОЯЩИЙ клиентский AudioCoordinator (+ sherpa KWS/VAD) → LabClient → сервер; забирает озвучку.
 *   Eval         — сценарии по ЦЕЛИ (словами), проверка по итоговому состоянию FakeDesktop, N прогонов, отчёт.
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";

// ───────────────────────── FakeDesktop ─────────────────────────

/** Обработчик ОДНОЙ команды клиенту. Обязан вернуть РОВНО один ActionResult с commandId = meta.commandId. */
export type ActionHandler = (cmd: ActionCommand, meta: { commandId: string; timeoutMs: number }) => Promise<ActionResult>;

/** Запись журнала эффектов: что ФАКТИЧЕСКИ произошло на «ПК» (для проверок по факту, а не по словам модели). */
export interface DesktopEffect {
  /** Монотонный номер эффекта в этом прогоне. */
  n: number;
  /** Виртуальные часы FakeDesktop (мс). */
  at: number;
  /** app.launch | app.close | window.focus | input.type | input.key | input.click | clipboard.write | fs.write | fs.delete | ... */
  kind: string;
  detail: Record<string, unknown>;
}

export interface DesktopWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  /** Текст, набранный в окно (для проверки «напечатал»). */
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  monitor: number;
  minimized: boolean;
}

export interface DesktopSnapshot {
  windows: DesktopWindow[];
  foregroundHwnd: number | null;
  clipboard: string;
  /** Файлы песочницы: путь (нормализованный, с /) → содержимое (utf8) или { binary: bytes }. */
  files: Record<string, string | { binary: number }>;
  volume: number;
  muted: boolean;
  media: { playing: boolean; title?: string };
  locked: boolean;
  /** Запущенные процессы (имя → сколько окон/экземпляров). */
  processes: Record<string, number>;
  effects: DesktopEffect[];
}

/** Начальное состояние прогона. Всё необязательное: по умолчанию — типовой рабочий стол Windows (Проводник, Chrome, ...). */
export interface DesktopSeed {
  windows?: Array<Partial<DesktopWindow> & { title: string; process: string }>;
  files?: Record<string, string>;
  clipboard?: string;
  volume?: number;
  /** Приложения, которые «установлены» и запускаются по имени (иначе app.launch → not_found). */
  installedApps?: string[];
  /** Сеть: адрес → HTML/текст (для невидимого браузера/поиска в лаборатории; пусто — оффлайн). */
  web?: Record<string, string>;
}

export interface FakeDesktop {
  /** Ответить на команду сервера (то, что сделал бы клиент). */
  handle: ActionHandler;
  snapshot(): DesktopSnapshot;
  reset(seed?: DesktopSeed): void;
  /** Виртуальные часы: продвинуть (wait_for, таймеры, «время суток» в контексте). */
  advance(ms: number): void;
  /** Внешнее событие: «владелец» сам двинул мышь / закрыл окно (для сценариев takeover). */
  userAction(kind: string, detail?: Record<string, unknown>): void;
  /** Подписка на эффекты (для eval-предикатов ожидания). */
  onEffect(cb: (e: DesktopEffect) => void): () => void;
}

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

// ───────────────────────── AudioStand ─────────────────────────

export interface AudioStandResult extends TurnResult {
  /** Что услышал ЛОКАЛЬНЫЙ слух клиента: сработал ли KWS, промахи, подстраховка, состояния гейта. */
  hearing: { wakeFired: boolean; gateOpened: boolean; rescueSent: boolean; rescueVerdict?: string; log: string[] };
  /** Текст, который распознал STT сервера для этой реплики (transcript). */
  transcript: string;
}

export interface AudioStand {
  /** Подать WAV (16 кГц mono s16le; другой формат — ресемплировать/отказать) через настоящий клиентский слух. */
  sayWav(wav: Buffer | string, opts?: { realtime?: boolean; tailSilenceMs?: number; timeoutMs?: number }): Promise<AudioStandResult>;
  /** Подать тишину/фон (проверка, что слух молчит). */
  feedNoise(kind: "silence" | "room" | "tv", ms: number): Promise<AudioStandResult>;
  close(): Promise<void>;
}

// ───────────────────────── Eval ─────────────────────────

export interface ScenarioContext {
  desktop: DesktopSnapshot;
  turn: TurnResult;
  server: LabServer;
}

export interface CheckResult {
  pass: boolean;
  /** Человеческое объяснение (что ожидали / что увидели) — идёт в отчёт. */
  why: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** Цель словами владельца — единственное, что получает мозг. НИКАКИХ подсказок про инструменты. */
  goal: string;
  tags: string[];
  /** Какие инструменты/виды команд/интенты этот сценарий ДОКАЗЫВАЕТ (для матрицы покрытия). */
  covers: string[];
  seed?: DesktopSeed;
  brain: "scripted" | "real" | "either";
  confirm?: ConfirmPolicy;
  budget: { maxMs: number; maxActions?: number };
  /** Проверка по ФАКТУ итогового состояния. */
  check(ctx: ScenarioContext): CheckResult | Promise<CheckResult>;
  /** Только «живьём»: нужен владелец/железо — сценарий описывает ЧТО проверять, раннер его пропускает с причиной. */
  liveOnly?: string;
}

export interface ScenarioRun {
  scenarioId: string;
  n: number;
  brain: "scripted" | "real";
  pass: boolean;
  why: string;
  ms: number;
  actions: number;
  tools: string[];
  answer: string;
  error?: string;
}

export interface EvalReport {
  startedAt: string;
  brain: "scripted" | "real";
  runs: ScenarioRun[];
  bySrenario: Record<string, { pass: number; total: number; rate: number; medianMs: number }>;
  skipped: Array<{ id: string; reason: string }>;
}

// ───────────────────────── Coverage ─────────────────────────

export interface CoverageRow {
  /** tool:<имя> | action:<kind> | intent:<kind> | flow:<id> */
  id: string;
  kind: "tool" | "action" | "intent" | "flow";
  /** unit | integration | lab-scripted | lab-real | live-only | none */
  coveredBy: string[];
  liveOnly?: string;
}

export interface CoverageMatrix {
  generatedAt: string;
  rows: CoverageRow[];
  totals: Record<string, number>;
  uncovered: string[];
}
