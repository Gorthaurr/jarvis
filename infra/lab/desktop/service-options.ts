/**
 * Опции сервисной группы FakeDesktop (code/skill/office/obs/сообщения/невидимый браузер). Читаются В МОМЕНТ вызова
 * обработчика (как env в проекте: `.env` грузится позже хойстинга), поэтому `setServiceOptions` после createFakeDesktop
 * действует сразу. Умолчания — БЕЗОПАСНЫЕ: code.run выключен, наружу ничего не уходит.
 */
import type { MessageChannel } from "@jarvis/protocol";
import type { CodeExecutor } from "./service-code-exec.js";

export interface TgChatSeed {
  title: string;
  /** Положительный — человек, отрицательный — группа/канал (конвенция TG). */
  peerId?: string;
  messages?: Array<{ dir: "in" | "out"; text: string }>;
}

export interface ServiceOptions {
  /** true → code.run исполняет РЕАЛЬНЫЙ интерпретатор в песочнице-tmp (cwd+env, НЕ файловая изоляция!). По умолчанию false. */
  allowCodeExec: boolean;
  /** Подмена исполнителя (сценарный фейк): безопасна, не требует allowCodeExec. */
  codeExecutor?: CodeExecutor;
  /** Каналы userbot с «живой сессией»; иначе message.send честно падает (как клиент без кредов). */
  connectedChannels: readonly MessageChannel[];
  /** Чаты веб-Telegram и вход; файл `~/.lab/telegram.json` в seed.files ({loggedIn, chats}) их перекрывает. */
  telegramLoggedIn: boolean;
  telegramChats: TgChatSeed[];
  /** true → сообщение «ушло», но подтвердить доставку нельзя (третий исход закона 1: uncertain). */
  telegramUnconfirmed: boolean;
  /** OBS: без запущенного процесса obs64/obs или без включённого WebSocket запрос честно не отвечает. */
  obsRequiresRunning: boolean;
  obsWebsocket: boolean;
  /** order.place: "unimplemented" — как настоящий клиент (throw «не реализован (M7)»); "record" — писать заказ без денег. */
  orderMode: "unimplemented" | "record";
  /** Бюджет реплея навыка, мс виртуального времени (как SKILL_REPLAY_BUDGET_MS клиента). */
  skillBudgetMs: number;
}

export const DEFAULT_SERVICE_OPTIONS: Readonly<ServiceOptions> = {
  allowCodeExec: false,
  connectedChannels: ["telegram", "vk"],
  telegramLoggedIn: true,
  telegramChats: [],
  telegramUnconfirmed: false,
  obsRequiresRunning: true,
  obsWebsocket: true,
  orderMode: "unimplemented",
  skillBudgetMs: 80_000,
};

let current: ServiceOptions = { ...DEFAULT_SERVICE_OPTIONS };

export function setServiceOptions(patch: Partial<ServiceOptions>): void {
  current = { ...current, ...patch };
}

export function getServiceOptions(): Readonly<ServiceOptions> {
  return current;
}

/** Вернуть умолчания (между тестами). */
export function resetServiceOptions(): void {
  current = { ...DEFAULT_SERVICE_OPTIONS };
}
