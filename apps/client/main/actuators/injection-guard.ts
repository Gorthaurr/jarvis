/**
 * W2 (пакет 0, решение №1): РУБЕЖ В ТОЧКЕ ИНЖЕКЦИИ — композиция трёх судей по порядку:
 *   self   — мутация в СВОЁ окно (модалка «Подтвердить» — обычный DOM-клик!) — неодобряемо (П1);
 *   secret — §0: пароль/код/карта в поле или в буфере вставки — неодобряемо (П2);
 *   commit — §14: коммит в рискованной программе без гранта в области → needsApproval (П1).
 * Цель судится по НАЙДЕННОМУ элементу и РЕАЛЬНОМУ процессу (injection-facts), одобрение — только из области
 * транспорта (approval-scope). P0: судьи-заглушки (null) — поведение прежнее, а все мутирующие RPC сайдкара уже
 * идут через этот вызов (inject.ts).
 */
import type { InjectOp } from "@jarvis/shared";
import { ActionError } from "./action-error.js";
import { type ApprovalScope, currentScope } from "./approval-scope.js";
import { commitJudge } from "./commit-judge.js";
import { type InjectionFacts, createInjectionFacts } from "./injection-facts.js";
import { secretJudge } from "./secret-judge.js";
import { selfJudge } from "./self-judge.js";

/** Что судим: операция сайдкара с её параметрами (или предпроверка: весь текст/все клавиши ДО первой инжекции). */
export interface InjectionCase {
  op: InjectOp;
  params: Record<string, unknown>;
  facts: InjectionFacts;
  scope: ApprovalScope | undefined;
  /** Предпроверка (preflightText/Keys): ничего не инжектируется, судится намерение целиком. */
  preflight?: boolean;
}

/** Отказ судьи. `data` — например `{needsApproval}` (protocol NeedsApproval) для вопроса владельцу через сервер. */
export interface JudgeDenial {
  message: string;
  data?: unknown;
  /** Часть действия уже ушла (кусок печати до Enter) — исход неизвестен. */
  injected?: boolean;
}

export type Judge = (c: InjectionCase) => Promise<JudgeDenial | null>;

/** Порядок — контракт: свой процесс раньше секрета, секрет раньше коммита (неодобряемое раньше одобряемого). */
export const JUDGES: ReadonlyArray<readonly [string, Judge]> = [
  ["self", selfJudge],
  ["secret", secretJudge],
  ["commit", commitJudge],
];

/** Рубеж отказал: протокольный `denied` (+ данные для вопроса) — dispatch отдаёт его серверу как есть. */
export class InjectionDeniedError extends ActionError {
  readonly judge: string;
  constructor(judge: string, d: JudgeDenial) {
    super(d.message, { code: "denied", data: d.data, injected: d.injected });
    this.name = "InjectionDeniedError";
    this.judge = judge;
  }
}

async function judgeCase(c: InjectionCase): Promise<void> {
  for (const [name, judge] of JUDGES) {
    const d = await judge(c);
    if (d) throw new InjectionDeniedError(name, d);
  }
}

/** Судить одну инжекцию. Бросает InjectionDeniedError; ничего не инжектирует. */
export async function guardInjection(op: InjectOp, params: Record<string, unknown>): Promise<void> {
  await judgeCase({ op, params, facts: createInjectionFacts(), scope: currentScope() });
}

/** Предпроверка ВСЕГО текста до первого куска и до записи в буфер обмена (G-15, П1/П2). */
export async function preflightText(text: string): Promise<void> {
  await judgeCase({ op: "type", params: { text }, facts: createInjectionFacts(), scope: currentScope(), preflight: true });
}

/** Предпроверка серии клавиш (куски печати: Enter/Tab между ними) до первой инжекции. */
export async function preflightKeys(combos: readonly string[]): Promise<void> {
  const facts = createInjectionFacts();
  for (const combo of combos) await judgeCase({ op: "key", params: { combo }, facts, scope: currentScope(), preflight: true });
}
