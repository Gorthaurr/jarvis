/**
 * Ядро check-kit: результаты, комбинаторы и выборки из контекста. Проверка — ФАКТ итогового состояния «ПК» и журнала
 * команд/вопросов, а не слова модели: слова (`answer`) читаются только там, где сам ответ и есть предмет проверки.
 */
import type { ActionCommand } from "@jarvis/protocol";
import type { CheckResult, DesktopEffect, DesktopWindow, TurnResult } from "../../lib/contracts.js";
import type { EvalContext } from "../types.js";

export const pass = (why: string): CheckResult => ({ pass: true, why });
export const fail = (why: string): CheckResult => ({ pass: false, why });

/** Все условия сразу: провал — причины провалившихся (зелёные молчат), успех — все причины через «; ». */
export function all(...rs: CheckResult[]): CheckResult {
  const bad = rs.filter((r) => !r.pass);
  return bad.length ? fail(bad.map((r) => r.why).join("; ")) : pass(rs.map((r) => r.why).join("; "));
}

/** Верхний регистр не различаем, «ё» = «е», пробелы схлопнуты: ответ модели и имена файлов пишутся по-разному. */
export const norm = (s: string): string => s.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
export const normPath = (p: string): string => p.replace(/\\/gu, "/").replace(/\/+/gu, "/").toLowerCase();

export const has = (text: string, m: string | RegExp): boolean => (typeof m === "string" ? norm(text).includes(norm(m)) : m.test(text));
export const show = (m: string | RegExp): string => (typeof m === "string" ? `«${m}»` : String(m));
export const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export const lastTurn = (ctx: EvalContext): TurnResult => ctx.turns[ctx.turns.length - 1] ?? ctx.turn;
export const answerOf = (ctx: EvalContext): string => lastTurn(ctx).answer;
/** Ответы ассистента по всем ходам (для проверок «в разговоре было сказано»). */
export const allAnswers = (ctx: EvalContext): string => ctx.turns.map((t) => t.answer).join(" \n ");

export const effectsOf = (ctx: EvalContext, kind: string | RegExp): DesktopEffect[] =>
  ctx.desktop.effects.filter((e) => (typeof kind === "string" ? e.kind === kind : kind.test(e.kind)));

/** Команды, ушедшие клиенту за ВСЮ сессию (в том числе получившие отказ): попытка — уже нарушение там, где действие запрещено. */
export const commandsOf = (ctx: EvalContext): ActionCommand[] => ctx.turns.flatMap((t) => t.actions.map((a) => a.cmd));
export const confirmsOf = (ctx: EvalContext): TurnResult["confirms"] => ctx.turns.flatMap((t) => t.confirms);

export const findWindows = (ctx: EvalContext, f: { process?: RegExp; title?: RegExp }, snap = ctx.desktop): DesktopWindow[] =>
  snap.windows.filter((w) => (!f.process || f.process.test(w.process)) && (!f.title || f.title.test(w.title)));
