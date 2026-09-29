/**
 * connectLabClient — настоящий WS-клиент по протоколу: hello, pong на ping, ровно один action.result на каждую команду
 * (исполняет FakeDesktop), ответы на §14 по ConfirmPolicy, resume при обрыве. `say()` — текстовый ход (dev.text) со сборкой
 * TurnResult. Ходы строго последовательны: сервер не сериализует кадры (`void dispatch`), два dev.text подряд шли бы параллельно.
 */
import { randomUUID } from "node:crypto";
import type { ActionCommand, ConfirmRequest, Envelope } from "@jarvis/protocol";
import { ActionRunner } from "./client-actions.js";
import { LabSocket } from "./client-socket.js";
import { isDevSession } from "../../../apps/server/src/gateway/dev-session.js";
import { buildTurn, settleSession, waitTurnEnd } from "./client-turn.js";
import type { LabClient, LabClientOptions, TurnResult } from "./contracts.js";
import { type ConfirmDecision, createConfirmRunner, toConfirmResult } from "./policy.js";
import { EventRecorder, type LabEvent } from "./recorder.js";

export interface LabClientConnectOptions extends LabClientOptions {
  connectTimeoutMs?: number;
  /** Переподключаться после обрыва (по умолчанию да). */
  reconnect?: boolean;
  /** Хранить аудио озвучки (speak.chunk.audio, base64) в events(): нужно аудио-стенду, чтобы сохранять звук в файл. */
  keepAudio?: boolean;
  /** Пауза после hello, чтобы онбординг полной сессии не попал в первый ход. По умолчанию 1500 мс; у dev-сессии онбординга нет — 0. */
  settleMs?: number;
}

/** Расширение контракта (надмножество): id конверта в событиях, журнал решений §14, счётчик переподключений. */
export interface LabClientHandle extends LabClient {
  /** То же, что events() контракта, но с id конверта (commandId у action.command). */
  events(): LabEvent[];
  decisions(): readonly ConfirmDecision[];
  reconnects(): number;
}

export async function connectLabClient(opts: LabClientConnectOptions): Promise<LabClientHandle> {
  const rec = new EventRecorder();
  const userToken = opts.token ?? randomUUID();
  const clientVersion = opts.clientVersion ?? "lab-1.0";
  const confirms = createConfirmRunner(opts.confirm);
  let sock: LabSocket;
  const runner = new ActionRunner(opts.desktop, (opts.faults ?? []).map((f) => ({ ...f })), {
    dropSocket: (ms) => sock.drop(ms),
    sendResult: (r) => sock.send("action.result", r, { queue: true }),
  });

  /** Ошибка отправки ответа (клиент закрывается / не вернулся после обрыва) не должна ронять процесс — пишем в журнал. */
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      rec.push("in", "lab.error", e instanceof Error ? e.message : String(e));
    }
  };
  const onFrame = (env: Envelope): void => {
    if (env.type === "ping") return safe(() => sock.send("pong", {}));
    if (env.type === "action.command") {
      runner.run(env.id, env.payload as ActionCommand & { timeoutMs?: number }).catch((e: unknown) => rec.push("in", "lab.error", String(e)));
    } else if (env.type === "user.confirm.request") {
      const q = env.payload as ConfirmRequest;
      const d = confirms.decide(String(q.summary ?? ""), String(q.kind ?? ""));
      safe(() => sock.send("user.confirm.result", toConfirmResult(String(q.requestId), d.answer), { queue: true }));
    }
  };

  sock = new LabSocket({
    url: opts.server.url,
    token: userToken,
    clientVersion,
    rec,
    onFrame,
    ...(opts.connectTimeoutMs ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
    ...(opts.reconnect === false ? { reconnect: false } : {}),
    ...(opts.keepAudio ? { keepAudio: true } : {}),
  });
  await sock.connect();
  await settleSession(rec, opts.settleMs ?? (isDevSession(clientVersion) ? 0 : 1_500));

  let chain: Promise<unknown> = Promise.resolve();
  const turn = async (text: string, o?: { timeoutMs?: number; waitTasks?: boolean }): Promise<TurnResult> => {
    if (!(await sock.whenOpen())) throw new Error("лаб-клиент не подключён: say невозможен (связь не восстановилась)");
    const mark = rec.length;
    const startedAt = Date.now();
    sock.send("dev.text", { text });
    const ended = await waitTurnEnd(rec, mark, { timeoutMs: o?.timeoutMs ?? 120_000, waitTasks: o?.waitTasks !== false });
    return buildTurn(text, rec.since(mark), startedAt, ended);
  };

  return {
    get sessionId() {
      return sock.sessionId;
    },
    userToken,
    say(text, o) {
      const p = chain.then(() => turn(text, o));
      chain = p.catch(() => undefined);
      return p;
    },
    events: () => rec.all(),
    send: (type, payload) => sock.send(type, payload),
    close: () => sock.close(),
    decisions: () => confirms.decisions,
    reconnects: () => sock.reconnects,
  };
}
