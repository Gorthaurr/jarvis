/**
 * Стенд (W1, только JARVIS_DEV_HTTP=1): сокет bench-сессии вместо живого клиента.
 *
 * Отвечает на §14-вопросы владельцу ДЕТЕРМИНИРОВАННО — по политике текущего вызова стенда (`benchCall`, хранится в
 * AsyncLocalStorage, чтобы вопрос, заданный фоновой задачей ПОСЛЕ конца вызова, не ушёл под чужую политику: такой
 * вопрос — «сирота», ответ «нет» + запись в `stray`). Каждый вопрос считается. ActionCommand клиенту ПК — честный
 * отказ (клиента нет: как у текст-драйвера, выдать это за успех нельзя). Остальные кадры копятся в вызове.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ConfirmOutcomeKind, ConfirmRequest } from "@jarvis/protocol";
import type { Session, SessionSocket } from "../session.js";

export type ConfirmAnswer = "yes" | "no" | "expire" | "undelivered";
export const CONFIRM_ANSWERS: readonly ConfirmAnswer[] = ["yes", "no", "expire", "undelivered"];

export interface BenchQuestion {
  n: number;
  kind: string;
  summary: string;
  answer: ConfirmAnswer;
  outcome: ConfirmOutcomeKind;
  atMs: number;
  /** Политика-массив кончилась — ответили отказоустойчивым «нет». */
  overflow?: boolean;
}

export interface BenchFrame {
  type: string;
  payload: unknown;
  atMs: number;
}

export interface BenchCall {
  startedAt: number;
  policy: ConfirmAnswer | ConfirmAnswer[];
  questions: BenchQuestion[];
  clientActions: Array<{ kind: string; atMs: number }>;
  frames: BenchFrame[];
  speakChunks: number;
  done: boolean;
}

/** Вопрос вне живого вызова (фоновая задача пережила вызов) — ответ «нет», запись для диагностики. */
export type StrayQuestion = { kind: string; summary: string; at: number };

const FRAMES_MAX = 500;
const STRAY_MAX = 50;
export const NO_CLIENT_MESSAGE = "стенд W1: клиента ПК нет — действие НЕ исполнено (результат не выполнен, не считай сделанным)";

export const benchCall = new AsyncLocalStorage<BenchCall>();

export function newBenchCall(policy: ConfirmAnswer | ConfirmAnswer[]): BenchCall {
  return { startedAt: Date.now(), policy, questions: [], clientActions: [], frames: [], speakChunks: 0, done: false };
}

/** Разобрать политику ответов: "yes" | ["yes","no"] | "yes,no". Пусто → "no". Мусор → null. */
export function parsePolicy(raw: unknown): ConfirmAnswer | ConfirmAnswer[] | null {
  if (raw === undefined || raw === null || raw === "") return "no";
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = list.map((x) => String(x).trim().toLowerCase());
  if (out.length === 0 || !out.every((x): x is ConfirmAnswer => (CONFIRM_ANSWERS as readonly string[]).includes(x))) return null;
  return !Array.isArray(raw) && out.length === 1 ? out[0]! : out;
}

function pickAnswer(call: BenchCall): { answer: ConfirmAnswer; overflow?: boolean } {
  if (!Array.isArray(call.policy)) return { answer: call.policy };
  const a = call.policy[call.questions.length];
  return a ? { answer: a } : { answer: "no", overflow: true };
}

const OUTCOME: Record<ConfirmAnswer, ConfirmOutcomeKind> = { yes: "approved", no: "denied", expire: "expired", undelivered: "undelivered" };

export class BenchSocket implements SessionSocket {
  private state = 1;
  private session?: Session;
  readonly stray: StrayQuestion[] = [];

  get readyState(): number {
    return this.state;
  }
  bind(session: Session): void {
    this.session = session;
  }
  close(): void {
    this.state = 3;
  }

  send(data: string): void {
    let env: { id?: string; type?: string; payload?: unknown };
    try {
      env = JSON.parse(data) as typeof env;
    } catch {
      return;
    }
    const store = benchCall.getStore();
    const call = store && !store.done ? store : undefined;
    if (env.type === "user.confirm.request") return this.answerConfirm(env.payload as ConfirmRequest, call);
    if (env.type === "action.command") return this.refuseAction(String(env.id ?? ""), env.payload, call);
    if (!call) return;
    if (env.type === "speak.chunk") {
      call.speakChunks += 1;
      return;
    }
    call.frames.push({ type: String(env.type ?? ""), payload: env.payload, atMs: Date.now() - call.startedAt });
    if (call.frames.length > FRAMES_MAX) call.frames.shift();
  }

  private answerConfirm(req: ConfirmRequest, call: BenchCall | undefined): void {
    const session = this.session;
    let answer: ConfirmAnswer = "no";
    if (call) {
      const pick = pickAnswer(call);
      answer = pick.answer;
      call.questions.push({
        n: call.questions.length + 1,
        kind: String(req.kind ?? ""),
        summary: String(req.summary ?? ""),
        answer,
        outcome: OUTCOME[answer],
        atMs: Date.now() - call.startedAt,
        ...(pick.overflow ? { overflow: true } : {}),
      });
    } else {
      this.stray.push({ kind: String(req.kind ?? ""), summary: String(req.summary ?? ""), at: Date.now() });
      if (this.stray.length > STRAY_MAX) this.stray.shift();
    }
    const requestId = String(req.requestId ?? "");
    const result =
      answer === "yes" || answer === "no"
        ? { requestId, approved: answer === "yes" }
        : { requestId, approved: false, outcome: OUTCOME[answer] };
    // Session кладёт запрос в pendingConfirms ПОСЛЕ send() (в executor промиса) — отвечаем на следующем тике.
    setImmediate(() => session?.resolveConfirm(result));
  }

  private refuseAction(commandId: string, payload: unknown, call: BenchCall | undefined): void {
    const kind = String((payload as { kind?: unknown } | undefined)?.kind ?? "");
    if (call) call.clientActions.push({ kind, atMs: Date.now() - call.startedAt });
    const session = this.session;
    setImmediate(() =>
      session?.resolveAction({ commandId, ok: false, error: { code: "runtime", message: NO_CLIENT_MESSAGE }, durationMs: 0 }),
    );
  }
}
