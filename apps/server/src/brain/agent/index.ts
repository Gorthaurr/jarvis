/**
 * Агент-цикл brain (§7, §21).
 *
 * M0-срез (РЕАЛЬНО): на текст пользователя классифицируем тир (router). Если это
 * локальный интент tier0 «открой/запусти/фокус X» — формируем ActionCommand
 * (app.launch / app.focus / browser.open), отправляем клиенту через session,
 * ждём ActionResult по commandId, пишем в action_log и возвращаем голосовой ответ.
 * Иначе — эхо-ответ (заглушка до подключения LLM, M2/M3).
 *
 * Полноценный agent-loop с tool-calls через @jarvis/tools и обращением к LLM
 * по тиру — следующий срез. Точка расширения помечена // TODO(M2/M3).
 */
import type { ActionCommand } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { buildActionLogEntry, insertActionLog } from "../../db/action-log.js";
import type { Session } from "../../gateway/session.js";
import type { WorkingMemory } from "../../memory/working.js";
import { type LocalIntent, classifyTier } from "../router/index.js";
import { verbalize } from "../verbalize/index.js";

const log: Logger = createLogger("agent");

/** Ответ агента по схеме §21: голос обязателен, карточка опциональна. */
export interface AgentReply {
  /** Текст для произнесения (уже прошедший verbalize). */
  voice: string;
  /** Опциональная карточка с подробностями для экрана. */
  display?: { title?: string; markdown: string };
}

/** Зависимости агента (инъекция для тестируемости). */
export interface AgentDeps {
  memory: WorkingMemory;
}

/**
 * Обработать текстовый ввод пользователя (вход dev.text или STT-транскрипт).
 * Возвращает ответ агента; отправку speak.chunk/ui.display делает вызывающий слой.
 */
export async function handleUserText(
  session: Session,
  text: string,
  deps: AgentDeps,
): Promise<AgentReply> {
  const clean = text.trim();
  deps.memory.pushTurn("user", clean);

  const decision = classifyTier(clean);
  log.info("маршрутизация", { tier: decision.tier, reason: decision.reason });

  let reply: AgentReply;

  if (decision.tier === "tier0" && decision.local) {
    reply = await runLocalIntent(session, decision.local);
  } else {
    // TODO(M2/M3): полноценный agent-loop —
    //   buildSystemPrompt() + recentTurns() → LLM выбранного тира (decision.tier)
    //   → tool-calls через @jarvis/tools → session.sendAction(...) в цикле
    //   → verbalize финального текста. Сейчас детерминированное эхо.
    reply = echoReply(clean, decision.tier);
  }

  deps.memory.pushTurn("assistant", reply.voice);
  return reply;
}

/** Выполнить локальный интент tier0 как одно действие round-trip (§5). */
async function runLocalIntent(session: Session, intent: LocalIntent): Promise<AgentReply> {
  const command = intentToCommand(intent);
  const result = await session.sendAction(command, DEFAULT_ACTION_TIMEOUT_MS);

  // Журнал действий (§13) — best-effort, не блокирует ответ.
  void insertActionLog(
    buildActionLogEntry(session.sessionId, result.commandId, command, result),
  );

  if (result.ok) {
    return { voice: verbalize(successPhrase(intent)) };
  }

  // §11: об ошибках — ровно, без юмора.
  log.warn("локальное действие не удалось", {
    kind: command.kind,
    code: result.error?.code,
  });
  return { voice: verbalize(failurePhrase(intent, result.error?.code)) };
}

/** Преобразовать локальный интент в абстрактный ActionCommand (§6). */
function intentToCommand(intent: LocalIntent): ActionCommand {
  switch (intent.kind) {
    case "app.launch":
      return { kind: "app.launch", app: intent.app };
    case "app.focus":
      return { kind: "app.focus", app: intent.app };
    case "browser.open":
      return { kind: "browser.open", url: intent.url };
  }
}

function successPhrase(intent: LocalIntent): string {
  switch (intent.kind) {
    case "app.launch":
      return `Открыл ${intent.app}.`;
    case "app.focus":
      return `Переключился на ${intent.app}.`;
    case "browser.open":
      return "Открыл.";
  }
}

function failurePhrase(intent: LocalIntent, code?: string): string {
  const reason =
    code === "timeout"
      ? "не дождался ответа"
      : code === "not_found"
        ? "не нашёл"
        : code === "disconnected"
          ? "связь с клиентом прервалась"
          : "не получилось";
  switch (intent.kind) {
    case "app.launch":
      return `Не вышло открыть ${intent.app}: ${reason}.`;
    case "app.focus":
      return `Не вышло переключиться на ${intent.app}: ${reason}.`;
    case "browser.open":
      return `Не вышло открыть страницу: ${reason}.`;
  }
}

/** Заглушка ответа для не-tier0 ввода (до подключения LLM, M2/M3). */
function echoReply(text: string, tier: string): AgentReply {
  return {
    voice: verbalize(`Принял. Пока умею открывать приложения и сайты по голосу.`),
    display: {
      title: "dev-эхо",
      markdown: `Маршрут: **${tier}**\n\nВвод: «${text}»\n\n> Полноценный agent-loop — следующий срез (M2/M3).`,
    },
  };
}
