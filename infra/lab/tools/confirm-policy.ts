/**
 * Политика ответов на §14-вопросы (ConfirmPolicy) → `ToolContext.confirm`. Зеркало стенда (gateway/bench/bench-socket.ts):
 * массив расходуется по порядку, кончился — честный отказ «нет» + пометка overflow (а не тихое «да»).
 * Каждый вопрос записывается: то, что владельца СПРОСИЛИ, — часть проверяемого поведения (закон 1).
 */
import type { ConfirmOutcomeKind } from "../../../packages/protocol/src/index.js";
import type { ConfirmOutcome } from "../../../apps/server/src/brain/tools/dispatch.js";
import type { ConfirmPolicy } from "../lib/contracts.js";

export type ConfirmAnswer = "yes" | "no" | "expire" | "undelivered";

export interface AskedQuestion {
  n: number;
  kind: string;
  summary: string;
  answer: ConfirmAnswer;
  outcome: ConfirmOutcomeKind;
  /** Политика-массив кончилась — ответили отказом. */
  overflow?: boolean;
}

const OUTCOME: Record<ConfirmAnswer, ConfirmOutcomeKind> = { yes: "approved", no: "denied", expire: "expired", undelivered: "undelivered" };

export interface ConfirmRecorder {
  confirm(summary: string, kind?: "send" | "order" | "irreversible"): Promise<ConfirmOutcome>;
  /** Вопросы с последнего reset (счётчик n политики-массива — тоже с него). */
  asked(): AskedQuestion[];
  reset(policy?: ConfirmPolicy): void;
}

function pick(policy: ConfirmPolicy, n: number, summary: string, kind: string): { answer: ConfirmAnswer; overflow?: boolean } {
  if (typeof policy === "string") return { answer: policy };
  if (typeof policy === "function") return { answer: policy(summary, kind, n) };
  const a = policy[n - 1];
  return a ? { answer: a } : { answer: "no", overflow: true };
}

/** По умолчанию политика «no»: без явного разрешения необратимое НЕ выполняется. */
export function createConfirmRecorder(initial: ConfirmPolicy = "no"): ConfirmRecorder {
  let policy = initial;
  let log: AskedQuestion[] = [];
  return {
    async confirm(summary, kind = "send") {
      const n = log.length + 1;
      const { answer, overflow } = pick(policy, n, summary, kind);
      const outcome = OUTCOME[answer];
      log.push({ n, kind, summary, answer, outcome, ...(overflow ? { overflow: true } : {}) });
      return { outcome, approved: outcome === "approved" };
    },
    asked: () => log.map((q) => ({ ...q })),
    reset(next) {
      log = [];
      if (next !== undefined) policy = next;
    },
  };
}
