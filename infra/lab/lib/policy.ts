/**
 * Политика ответов на вопросы §14 (user.confirm.request) для лаб-клиента. Чистая логика без сети — проверяется юнитами.
 * Честность: неизвестное/кончившееся = «нет» (необратимое не подтверждаем по умолчанию), а исчерпание массива помечается
 * `overflow`, чтобы сценарий не принял молчаливый отказ за осознанный.
 */
import type { ConfirmResult } from "@jarvis/protocol";
import type { ConfirmPolicy } from "./contracts.js";

export type ConfirmAnswer = "yes" | "no" | "expire" | "undelivered";
export const CONFIRM_ANSWERS: readonly ConfirmAnswer[] = ["yes", "no", "expire", "undelivered"];

export interface ConfirmDecision {
  /** Номер вопроса с 1. */
  n: number;
  summary: string;
  kind: string;
  answer: ConfirmAnswer;
  /** Ответ взят не из политики: массив кончился или функция вернула мусор → «no». */
  overflow?: boolean;
}

export interface ConfirmRunner {
  decide(summary: string, kind: string): ConfirmDecision;
  readonly decisions: readonly ConfirmDecision[];
}

const valid = (a: unknown): a is ConfirmAnswer => CONFIRM_ANSWERS.includes(a as ConfirmAnswer);

/** Исполнитель политики: хранит счётчик вопросов и журнал решений. По умолчанию (политики нет) — «no». */
export function createConfirmRunner(policy: ConfirmPolicy = "no"): ConfirmRunner {
  const decisions: ConfirmDecision[] = [];
  return {
    decisions,
    decide(summary, kind) {
      const n = decisions.length + 1;
      let raw: unknown;
      if (typeof policy === "function") {
        try {
          raw = policy(summary, kind, n);
        } catch {
          raw = undefined; // упавшая функция политики не должна валить ход: честное «no» + overflow
        }
      } else raw = Array.isArray(policy) ? policy[n - 1] : policy;
      const answer: ConfirmAnswer = valid(raw) ? raw : "no";
      const d: ConfirmDecision = { n, summary, kind, answer, ...(answer === raw ? {} : { overflow: true }) };
      decisions.push(d);
      return d;
    },
  };
}

/** Ответ протокола. expire/undelivered отправляются СРАЗУ с outcome (иначе ждали бы всё окно вопроса): resolveConfirm его пробрасывает как есть. */
export function toConfirmResult(requestId: string, answer: ConfirmAnswer): ConfirmResult {
  if (answer === "yes") return { requestId, approved: true };
  if (answer === "no") return { requestId, approved: false };
  return { requestId, approved: false, outcome: answer === "expire" ? "expired" : "undelivered" };
}

/** Обратно: какой ответ стоит за ConfirmResult (для сборки TurnResult из журнала событий). */
export function answerOf(r: Pick<ConfirmResult, "approved" | "outcome">): ConfirmAnswer {
  if (r.approved) return "yes";
  if (r.outcome === "expired") return "expire";
  if (r.outcome === "undelivered") return "undelivered";
  return "no";
}

/** CLI: "yes" | "yes,no,expire". Мусор → ошибка (не молчаливое «no»). */
export function parseConfirmPolicy(raw: string): ConfirmPolicy {
  const list = raw.split(",").map((x) => x.trim().toLowerCase());
  if (!list.length || !list.every(valid)) {
    throw new Error(`политика подтверждений «${raw}»: допустимо ${CONFIRM_ANSWERS.join("|")} или список через запятую`);
  }
  return list.length === 1 ? (list[0] as ConfirmAnswer) : (list as ConfirmAnswer[]);
}
