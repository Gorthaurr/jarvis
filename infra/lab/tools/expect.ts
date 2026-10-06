/**
 * Проверка ожиданий кейса против результата вызова. Возвращает СПИСОК провалов (пусто — кейс прошёл):
 * каждый провал — понятная фраза «ожидали X / увидели Y», она идёт в отчёт как есть.
 */
import type { DesktopEffect } from "../lib/contracts.js";
import type { EffectCheck, ToolExpect } from "./case-format.js";
import type { ToolCallOutcome } from "./harness.js";

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const matches = (text: string, m: string | RegExp): boolean => (typeof m === "string" ? text.includes(m) : m.test(text));
const show = (m: string | RegExp): string => (typeof m === "string" ? JSON.stringify(m) : String(m));
const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** `sub` — подмножество `full` (глубоко по объектам, точно по остальному). */
export function isSubset(sub: unknown, full: unknown): boolean {
  if (sub && typeof sub === "object" && !Array.isArray(sub)) {
    if (!full || typeof full !== "object") return false;
    return Object.entries(sub as Record<string, unknown>).every(([k, v]) => isSubset(v, (full as Record<string, unknown>)[k]));
  }
  if (Array.isArray(sub)) return Array.isArray(full) && sub.length === full.length && sub.every((v, i) => isSubset(v, full[i]));
  return sub === full;
}

function checkEffect(c: EffectCheck, effects: DesktopEffect[], o: ToolCallOutcome): string | null {
  if (typeof c === "function") {
    const r = c(effects, o.snapshot);
    return r === true ? null : `предикат эффектов не выполнен${typeof r === "string" ? `: ${r}` : ""}`;
  }
  if ("none" in c) {
    const bad = effects.filter((e) => e.kind === c.none);
    return bad.length ? `эффект ${c.none} быть не должен, а был ×${bad.length}` : null;
  }
  const hit = effects.filter((e) => e.kind === c.has && (c.detail === undefined || isSubset(c.detail, e.detail)));
  const need = c.count ?? 1;
  if (c.count === undefined ? hit.length >= 1 : hit.length === need) return null;
  const kinds = effects.map((e) => e.kind).join(", ") || "—";
  return `эффект ${c.has}${c.detail ? ` ${JSON.stringify(c.detail)}` : ""}: ждали ${c.count === undefined ? "≥1" : need}, было ${hit.length} (все эффекты: ${kinds})`;
}

export function evaluate(exp: ToolExpect, o: ToolCallOutcome): string[] {
  const fails: string[] = [];
  const text = o.text;
  if (exp.notVerifiable !== undefined) {
    if (!o.notVerifiable) fails.push("ждали «не проверяется в лаборатории», но инструмент был вызван");
    else if (!matches(o.notVerifiable, exp.notVerifiable)) fails.push(`причина «не проверяется»: ждали ${show(exp.notVerifiable)}, увидели ${JSON.stringify(o.notVerifiable)}`);
  } else if (o.notVerifiable) {
    fails.push(`инструмент не проверяется в лаборатории (${o.notVerifiable}) — кейс невозможен без подключённой части ctx`);
  }
  if (exp.ok !== undefined && !o.isError !== exp.ok) fails.push(exp.ok ? `ждали успех, а инструмент вернул ошибку: ${clip(text)}` : `ждали честную ошибку, а инструмент вернул успех: ${clip(text)}`);
  for (const m of asList(exp.resultIncludes)) if (!matches(text, m)) fails.push(`в ответе нет ${show(m)}; ответ: ${clip(text)}`);
  for (const m of asList(exp.resultExcludes)) if (matches(text, m)) fails.push(`в ответе не должно быть ${show(m)}; ответ: ${clip(text)}`);
  for (const [flag, want] of Object.entries(exp.flags ?? {})) {
    const has = (o.result as unknown as Record<string, unknown>)[flag] === true;
    if (has !== want) fails.push(`флаг ${flag}: ждали ${want ? "выставлен" : "НЕ выставлен"}, а он ${has ? "выставлен" : "не выставлен"}`);
  }
  if (exp.actionKinds) {
    const got = o.actions.map((a) => a.cmd.kind);
    if (got.join(",") !== exp.actionKinds.join(",")) fails.push(`команды клиенту: ждали [${exp.actionKinds.join(", ")}], ушло [${got.join(", ")}]`);
  }
  if (exp.asked !== undefined && o.asked.length !== exp.asked) fails.push(`вопросов владельцу: ждали ${exp.asked}, задано ${o.asked.length}`);
  for (const c of exp.effects ?? []) {
    const f = checkEffect(c, o.effects, o);
    if (f) fails.push(f);
  }
  if (exp.state) {
    const r = exp.state(o.snapshot);
    if (r !== true) fails.push(`итоговое состояние «ПК»${typeof r === "string" ? `: ${r}` : " не подошло"}`);
  }
  return fails;
}
