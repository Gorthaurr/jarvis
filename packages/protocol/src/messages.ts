/**
 * Сообщения протокола клиент↔сервер (§5).
 * Brain эмитит абстрактные команды, клиент мапит на актуаторы.
 */
import type { ActionCommand, SkillStep } from "./actions.js";

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
  | "demo.save" // DemoSave — завершить запись демонстрации и сохранить навык (§8)
  | "task.control" // TaskControl — управление задачей из UI (кнопка «стоп»/«пауза», §20)
  | "client.takeover" // Takeover — пользователь взялся за мышь/клаву → агент уступает (§6)
  | "client.env" // ClientEnv — авто-профиль окружения (браузер/приложения) → агент адаптируется (§9)
  | "client.system" // ClientSystem — живой снимок: что открыто/на переднем плане/мониторы → хвост промпта
  | "client.settings" // ClientSettings — язык/контекст из настроек UI → профиль (персона)
  | "client.usage.request" // запрос текущего расхода/лимитов для вкладки «Оплата» (§6B/B5)
  | "client.keys" // ClientKeys — API-ключи из UI → сервер шифрует в user_credentials (§6B/B4)
  | "voice.enroll.start" // VoiceEnrollStart — начать запись голосового отпечатка (§3)
  | "voice.enroll.cancel" // отменить запись отпечатка
  | "voice.list" // запросить список enrolled-голосов
  | "voice.remove" // VoiceName — удалить голос по имени
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
  | "chat" // ChatMessage — реплика для текстового чата (роль+текст), §22
  | "usage.info" // UsageInfo — расход/потолок/лимиты периода для вкладки «Оплата» (§6B/B5)
  | "skill.saved" // SkillSaved — навык записан/сохранён, доступен для повтора (§8)
  | "voice.enroll.progress" // VoiceEnrollProgress — % готовности записи отпечатка (§3)
  | "voice.enroll.done" // VoiceEnrollDone — отпечаток записан (или нет)
  | "voice.voices" // VoiceList — текущий список enrolled-голосов
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

/** §3 верификация диктора: начать запись голосового отпечатка под именем. */
export interface VoiceEnrollStart {
  name: string;
}
/** §3: удалить/назвать голос. */
export interface VoiceName {
  name: string;
}
/** §3: прогресс записи отпечатка (0..1). */
export interface VoiceEnrollProgress {
  percent: number;
}
/** §3: запись отпечатка завершена. */
export interface VoiceEnrollDone {
  name: string;
  ok: boolean;
}
/** §3: текущий список enrolled-голосов. */
export interface VoiceList {
  names: string[];
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
    // channel_down (Б4): сокет временно недоступен (обрыв в resume-grace), сессия ЖИВА — команда не
    // выполнена, но это НЕ провал действия и НЕ повод эскалировать тир (мёртвый канал ≠ слабая модель).
    // Отличается от disconnected (сессия закрыта окончательно).
    code: "timeout" | "not_found" | "denied" | "disconnected" | "channel_down" | "runtime";
    message: string;
  };
  /** напр. {handle, bbox} от ui.ground, stdout от code.run. */
  data?: unknown;
  /** при skill.execute — номер шага. */
  stepIndex?: number;
  durationMs: number;
}

/**
 * Настройки из UI (вкладка «Общее») → профиль на сервере (персона). Только то, что сервер
 * умеет применять: язык общения и свободный контекст «что Джарвису знать о вас». API-ключи
 * сюда НЕ входят — они хранятся локально на клиенте (safeStorage), сервер их не получает.
 */
export interface ClientSettings {
  /** Язык распознавания/ответов (напр. "ru"/"en"). */
  language?: string;
  /** Свободный контекст о пользователе (стиль, привычки, как обращаться). */
  context?: string;
}

/**
 * §6B/B4: API-ключи интеграций из UI → сервер шифрует и кладёт в user_credentials (per-user).
 * service — каноническое имя ('anthropic'|'elevenlabs'|'deepgram'|...). value — ПЛЕЙНТЕКСТ ключа
 * (на loopback WS — та же граница доверия, что и токен; в hosted — поверх TLS). Сервер НЕ хранит
 * открытым: шифрует at-rest (AES-256-GCM). Пустое value — пропускаем (не затираем прежний).
 */
export interface ClientKeys {
  keys: Array<{ service: string; value: string }>;
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
 * Завершить запись демонстрации и сохранить навык (§8). Клиент накопил UIA-события
 * (sidecar WinEvent-хук), здесь шлёт весь батч с именем — сервер строит черновик
 * SKILL.md (buildSkillDraft) и сохраняет. commentary — голосовой комментарий, если был.
 */
export interface DemoSave {
  name: string;
  events: DemoEvent[];
  commentary?: string;
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

/**
 * Пользователь взялся за мышь/клавиатуру во время автономной работы агента (§6).
 * Клиент шлёт active:true (физический ввод детектирован сайдкаром, не наша синтетика)
 * → сервер ставит активную задачу на паузу (агент уступает управление). По простою
 * (active:false) — возобновляет. Так можно «отпустить руки» и перехватить в любой момент.
 */
export interface Takeover {
  active: boolean;
}

/**
 * Авто-профиль окружения пользователя (§9): клиент САМ определяет браузер по умолчанию,
 * установленные браузеры/приложения и шлёт краткую сводку — сервер подставляет её в
 * системный промпт, чтобы агент адаптировался под конкретного человека (не хардкод).
 */
export interface ClientEnv {
  summary: string;
  /** §Волна2 (2.6): СТРУКТУРНЫЕ имена приложений — лексикон STT-нормализатора (строку summary не парсим). */
  apps?: string[];
  /** §Волна2 (2.6): имена установленных Steam-игр (из манифестов) — туда же. */
  games?: string[];
}

/**
 * Живой системный снимок (§ контекст системы): что СЕЙЧАС открыто/на переднем плане + на каком
 * мониторе. В ОТЛИЧИЕ от ClientEnv (статика «что установлено») — обновляется периодически. Сервер
 * кладёт в некешируемый хвост промпта → агент каждый ход знает, что запущено и где (без tool-call).
 */
export interface ClientSystem {
  summary: string;
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
  /** §Волна3 (3.5): сырой PCM16-стрим (v3 TTS) — играть чанки по мере прихода. Отсутствует = mp3. */
  format?: "pcm16";
  /** Частота PCM (только при format="pcm16"). */
  sampleRate?: number;
}

export interface Transcript {
  text: string;
  final: boolean;
}

/** Реплика текстового чата (§22): роль + текст. user — что сказал/напечатал пользователь,
 *  assistant — ответ Джарвиса. Используется чат-вкладкой и текстовым фидбэком при mute. */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
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
  /** Краткая СУТЬ задачи для чипа (напр. «Реферат о Петре I»), не сырая реплика. */
  title?: string;
  /** Полная формулировка цели (для тултипа/отчёта голосом). */
  summary?: string;
  stepsDone?: number;
  stepsTotal?: number;
}

/** Карточка подробностей в renderer (§21). voice и экран — разные каналы. */
export interface DisplayCard {
  title?: string;
  markdown: string;
}

/**
 * Навык записан/сохранён и доступен для повтора (§8). Сервер шлёт после demo.save
 * (или на старте сессии — список ранее записанных навыков). steps идут вместе,
 * чтобы клиент мог повторить навык локально (skill-runner) без обращения к серверу.
 */
export interface SkillSaved {
  id: string;
  name: string;
  version: number;
  steps: SkillStep[];
  /** есть guard-шаги → перед первым применением нужно ревью (§14). */
  needsReview: boolean;
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

/**
 * Расход и лимиты текущего периода для вкладки «Оплата» (§6B/B5). Read-only: сервер считает,
 * клиент только отображает (никогда не доверяем клиентскому плану/лимиту). §0-p5: НИКАКИХ
 * карточных/платёжных данных — только учёт стоимости LLM и счётчиков.
 */
export interface UsageInfo {
  /** Метка тарифа (напр. "Базовый"/"Pro") — производная, не платёжные данные. */
  plan: string;
  /** Период учёта 'YYYY-MM'. */
  period: string;
  /** Потрачено за период (в валюте бюджета). */
  spent: number;
  /** Потолок трат за период. */
  cap: number;
  /** Остаток до потолка. */
  remaining: number;
  /** Аварийный стоп активен (платные операции заблокированы, §14). */
  killSwitch: boolean;
}

// ── удобные алиасы конвертов на типы payload ─────────────────

export type ActionCommandEnvelope = Envelope<ActionCommand & { timeoutMs: number }>;
