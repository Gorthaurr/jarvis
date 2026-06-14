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
  type AudioFrame,
  type ClientContext,
  type ClientStateMsg,
  type ConfirmResult,
  type DevText,
  type Envelope,
  type MessageType,
  type VadEvent,
} from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { type AgentReply, handleUserText } from "../brain/agent/index.js";
import type { ISttProvider, ITtsProvider, TtsChunk } from "../integrations/voice-providers.js";
import { WorkingMemory } from "../memory/working.js";
import { noteClientContext } from "../proactive/salience.js";
import { type VoicePipeline, createVoicePipeline } from "../voice/index.js";
import type { HeartbeatHandle } from "./heartbeat.js";
import type { Session } from "./session.js";

const log: Logger = createLogger("router-ws");

/** Голосовые провайдеры, общие на gateway (создаются один раз из конфига). */
export interface VoiceProviders {
  stt: ISttProvider;
  tts: ITtsProvider;
  voiceId?: string;
}

/** Контекст одного соединения, который держит router между сообщениями. */
export interface SessionContext {
  session: Session;
  memory: WorkingMemory;
  heartbeat: HeartbeatHandle;
  /** Голосовой пайплайн сессии (§10). */
  voice: VoicePipeline;
  /** Последний полученный ClientContext — вход для proactive (§9). */
  lastContext?: ClientContext;
}

/** Создать контекст для свежей/возобновлённой сессии. */
export function makeSessionContext(
  session: Session,
  heartbeat: HeartbeatHandle,
  providers: VoiceProviders,
): SessionContext {
  const memory = new WorkingMemory();
  const voice = createVoicePipeline({
    stt: providers.stt,
    tts: providers.tts,
    ttsVoiceId: providers.voiceId,
    // brain на финальном тексте реплики (§21: {voice, display?}).
    onUserTurn: (text) => handleUserText(session, text, { memory }),
    // speak.chunk: аудио по WS — DEV-путь (в проде WebRTC, §5). Кодируем в base64.
    sendSpeakChunk: (c: TtsChunk) =>
      session.send("speak.chunk", { audio: bufToBase64(c.audio), seq: c.seq, last: c.last }),
    sendClientState: (s) => session.send("client.state", { state: s }),
    sendTranscript: (t) => session.send("transcript", t),
    sendDisplay: (d) => session.send("ui.display", d),
  });
  return { session, memory, heartbeat, voice };
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
    case "audio.frame": {
      const f = env.payload as AudioFrame;
      ctx.voice.onAudioFrame(toArrayBuffer(f.pcm));
      break;
    }
    case "audio.vad":
      ctx.voice.onVadEvent((env.payload as VadEvent).state);
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
  // Примечание: голосовой ответ (speak.chunk из TTS) идёт через VoicePipeline
  // на голосовом пути (audio.frame→STT→agent→TTS). Текстовый dev.text-путь
  // отдаёт только transcript/ui.display.
}

// ── кодирование аудио для DEV-пути по WS (§5: в проде — WebRTC) ──────────

/** ArrayBuffer → base64 (speak.chunk по JSON-WS). */
function bufToBase64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}

/** Нормализовать входящий pcm (base64-строка | массив | ArrayBuffer) в ArrayBuffer. */
function toArrayBuffer(pcm: unknown): ArrayBuffer {
  if (pcm instanceof ArrayBuffer) return pcm;
  if (typeof pcm === "string") return copyBytes(Buffer.from(pcm, "base64"));
  if (Array.isArray(pcm)) return copyBytes(Uint8Array.from(pcm as number[]));
  if (ArrayBuffer.isView(pcm)) {
    const v = pcm as ArrayBufferView;
    return copyBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  return new ArrayBuffer(0);
}

/** Скопировать байты в свежий ArrayBuffer (исключает SharedArrayBuffer из типа). */
function copyBytes(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
