/**
 * ПРОВОДКА сессии владельца к сервисам проактива - ровно как gateway/router-ws.ts:795-847: реплики идут в НАСТОЯЩУЮ очередь
 * озвучки (VoicePipeline.speakQueued, retriable + onOutcome), поверх - фейковый TTS. Так «принято в очередь» и «прозвучало»
 * различаются так же, как в бою, а исход реплики возвращается сервису теми же колбэками.
 */
import { verbalize } from "../../../apps/server/src/brain/verbalize/index.js";
import type { PredicateSender } from "../../../apps/server/src/proactive/watch/service.js";
import { createVoicePipeline } from "../../../apps/server/src/voice/index.js";
import type { VoicePipeline } from "../../../apps/server/src/voice/pipeline.js";
import { FAULT } from "./kit.js";
import type { Journal } from "./journal.js";
import type { Services } from "./services.js";
import { type FakeTts, NullStt } from "./tts-fake.js";

export interface OwnerOpts {
  userId?: string;
  sessionId?: string;
  /** Владелец занят (звонок/полный экран/блокировка) - можно менять на лету через `owner.busy`. */
  busy?: boolean;
  /** Клиентская проверка предиката (wait.for); не задан - канал действий не регистрируется. */
  predicate?: PredicateSender;
  /** Запускатель агентской петли: если бросает - сервис должен это пережить. */
  runner?: (goal: string) => void;
  /** Dev-сессия (текст-драйвер) не получатель: сервисам её не регистрируем (router-ws.ts:794). */
  dev?: boolean;
}

export interface Owner {
  readonly sessionId: string;
  readonly userId: string;
  readonly voice: VoicePipeline;
  busy: boolean;
  disconnect(): void;
}

export interface WireEnv {
  svc: Services;
  journal: Journal;
  tts: FakeTts;
}

let seq = 0;

export function connectOwner(env: WireEnv, o: OwnerOpts = {}): Owner {
  const { svc, journal, tts } = env;
  const sessionId = o.sessionId ?? `s${++seq}`;
  const userId = o.userId ?? "owner";
  const state = { busy: o.busy ?? false };
  const voice = createVoicePipeline({
    stt: new NullStt(),
    tts,
    onUserTurn: async () => ({ voice: "" }),
    sendSpeakChunk: (c) => journal.add("sound", { source: "tts", text: tts.lastText, detail: { seq: c.seq, session: sessionId } }),
    sendClientState: () => {},
    isUserBusy: () => state.busy,
    now: () => Date.now(),
  });
  const enqueue = (source: string, text: string, urgent: boolean, onOutcome?: (spoken: boolean) => void): boolean => {
    const said = verbalize(text);
    const accepted = voice.speakQueued(said, urgent, {
      retriable: true,
      ...(onOutcome
        ? { onOutcome: (spoken: boolean) => { journal.add("outcome", { source, text: said, detail: { spoken } }); onOutcome(spoken); } }
        : {}),
    });
    journal.add(accepted ? "queued" : "refused", { source, text: said, detail: { urgent } });
    return accepted;
  };
  const owner: Owner = {
    sessionId,
    userId,
    voice,
    get busy() {
      return state.busy;
    },
    set busy(v: boolean) {
      state.busy = v;
      voice.drainPending(); // как router-ws при смене client.context: «освободился» дёргает дренаж
    },
    disconnect() {
      svc.reminders.unregisterSpeaker(sessionId);
      svc.watch.unregisterSpeaker(sessionId);
      svc.watch.unregisterActions(sessionId);
      svc.watch.unregisterRunner(sessionId);
      svc.ambient.unregisterSpeaker(sessionId);
      voice.dispose(); // смерть сессии: невоспроизведённое откатывается через onOutcome(false)
    },
  };
  journal.add("mark", { text: `connect ${sessionId}/${userId}` });
  if (o.dev || FAULT === "ownerless") return owner;
  svc.reminders.registerSpeaker(sessionId, userId, (text, oc) => enqueue("reminder", text, true, oc));
  svc.watch.registerSpeaker(sessionId, userId, (text, oc) => enqueue("watch", text, true, oc));
  if (o.predicate) svc.watch.registerActions(sessionId, userId, o.predicate);
  svc.watch.registerRunner(sessionId, userId, (goal) => {
    journal.add("action", { text: goal });
    o.runner?.(goal);
  });
  svc.ambient.registerSpeaker(sessionId, userId, (text, urgent, oc) => enqueue("ambient", text, urgent, oc), () => state.busy);
  return owner;
}

/** Клиентский wait.for: возвращает то, что сейчас лежит в `state` (met/unknown/ошибка), и пишет вызов в журнал. */
export interface PredicateState {
  met: boolean;
  unknown?: boolean;
  error?: string;
  calls: number;
}

export function predicateSender(journal: Journal, state: PredicateState): PredicateSender {
  return async (cmd) => {
    state.calls += 1;
    journal.add("predicate", { text: String(cmd.kind), detail: { met: state.met, unknown: state.unknown === true } });
    if (state.error) return { ok: false, error: { message: state.error } };
    return { ok: true, data: { met: state.met, ...(state.unknown ? { unknown: true, detail: "lab" } : {}) } };
  };
}
