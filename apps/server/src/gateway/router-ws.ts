/**
 * Диспетчер входящих WS-сообщений (§5).
 *
 * Принимает разобранный Envelope и маршрутизирует по MessageType:
 *   dev.text            → brain.handleUserText → speak.chunk-ответ (M0: transcript+ui.display)
 *   action.result       → резолв in-flight команды в Session
 *   pong                → heartbeat.notePong
 *   client.context      → proactive (salience-вход §9)
 *   user.confirm.result → резолв ожидающего confirm в Session
 *   client.state        → лог/диагностика
 *   audio.* / vad       → точка под голосовой пайплайн (M1) — пока лог
 *
 * Router держит per-session состояние (рабочая память) в SessionContext.
 */
import {
  type ActionResult,
  type ClientContext,
  type ClientStateMsg,
  type ConfirmResult,
  type DevText,
  type Envelope,
  type MessageType,
} from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { type AgentReply, handleUserText } from "../brain/agent/index.js";
import { WorkingMemory } from "../memory/working.js";
import { noteClientContext } from "../proactive/salience.js";
import type { HeartbeatHandle } from "./heartbeat.js";
import type { Session } from "./session.js";

const log: Logger = createLogger("router-ws");

/** Контекст одного соединения, который держит router между сообщениями. */
export interface SessionContext {
  session: Session;
  memory: WorkingMemory;
  heartbeat: HeartbeatHandle;
  /** Последний полученный ClientContext — вход для proactive (§9). */
  lastContext?: ClientContext;
}

/** Создать контекст для свежей/возобновлённой сессии. */
export function makeSessionContext(session: Session, heartbeat: HeartbeatHandle): SessionContext {
  return { session, memory: new WorkingMemory(), heartbeat };
}

/**
 * Обработать одно входящее сообщение. Возвращает Promise — вызывающий
 * (gateway) может не ждать, но мы await'им для упорядоченной обработки текста.
 */
export async function dispatch(ctx: SessionContext, env: Envelope): Promise<void> {
  const type = env.type as MessageType;
  switch (type) {
    case "dev.text":
      await onDevText(ctx, env.payload as DevText);
      break;
    case "action.result":
      ctx.session.resolveAction(env.payload as ActionResult);
      break;
    case "user.confirm.result":
      ctx.session.resolveConfirm(env.payload as ConfirmResult);
      break;
    case "pong":
      ctx.heartbeat.notePong();
      break;
    case "client.context": {
      const c = env.payload as ClientContext;
      ctx.lastContext = c;
      noteClientContext(ctx.session.sessionId, c); // вход salience (§9)
      break;
    }
    case "client.state":
      log.debug("client.state", (env.payload as ClientStateMsg).state);
      break;
    case "audio.frame":
    case "audio.vad":
      // TODO(M1): голосовой пайплайн вынесен в отдельный процесс (см. voice/).
      log.debug("аудио-сообщение (M1, пока игнор)", { type });
      break;
    case "screen.capture.result":
      // Результат screen.capture коррелируется как ActionResult в проде;
      // M0 — лог. TODO(M2): связать со screen.capture command.
      log.debug("screen.capture.result получен");
      break;
    case "demo.event":
      // TODO(M? §8): запись демонстрации навыка.
      log.debug("demo.event (обучение демонстрацией — позже)");
      break;
    default:
      log.warn("необработанный тип входящего сообщения", { type });
  }
}

/** dev.text → агент → ответ клиенту (transcript + speak + опц. карточка). */
async function onDevText(ctx: SessionContext, payload: DevText): Promise<void> {
  const text = payload?.text ?? "";
  if (!text.trim()) return;

  ctx.session.send("client.state", { state: "thinking" });
  let reply: AgentReply;
  try {
    reply = await handleUserText(ctx.session, text, { memory: ctx.memory });
  } catch (e) {
    log.error("ошибка agent.handleUserText", e instanceof Error ? e.message : String(e));
    ctx.session.send("client.state", { state: "idle" });
    ctx.session.send("error", { code: "internal", message: "внутренняя ошибка обработки" });
    return;
  }

  sendReply(ctx, reply);
}

/**
 * Отправить ответ агента клиенту.
 * M0: голос как Transcript (текст) — реальный TTS-стрим speak.chunk появится в M1.
 * Карточка (если есть) — отдельным каналом ui.display (§21).
 */
function sendReply(ctx: SessionContext, reply: AgentReply): void {
  ctx.session.send("transcript", { text: reply.voice, final: true });
  if (reply.display) ctx.session.send("ui.display", reply.display);
  ctx.session.send("client.state", { state: "idle" });
  // TODO(M1): здесь же стримить speak.chunk из TTS-провайдера.
}
