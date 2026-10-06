/** Проверки окон и программ: запущено, закрыто, на каком мониторе, не тронуты ли остальные. */
import type { CheckResult } from "../../lib/contracts.js";
import type { EvalContext } from "../types.js";
import { fail, findWindows, has, pass, show } from "./core.js";

type Sel = { process?: RegExp; title?: RegExp };
const label = (s: Sel): string => [s.process && `процесс ${s.process}`, s.title && `заголовок ${s.title}`].filter(Boolean).join(", ");

export function windowOpen(ctx: EvalContext, s: Sel): CheckResult {
  const w = findWindows(ctx, s);
  return w.length ? pass(`окно есть (${label(s)}): «${w[0]!.title}»`) : fail(`нет окна (${label(s)}); открыты: ${ctx.desktop.windows.map((x) => x.process).join(", ") || "—"}`);
}

export function windowGone(ctx: EvalContext, s: Sel): CheckResult {
  const w = findWindows(ctx, s);
  return w.length ? fail(`окно не закрыто (${label(s)}): «${w[0]!.title}»`) : pass(`окон нет (${label(s)})`);
}

/** Текст в окне программы (набранное в блокноте): ищем во ВСЕХ подходящих окнах — окон может быть два. */
export function windowText(ctx: EvalContext, s: Sel, text: string | RegExp): CheckResult {
  const ws = findWindows(ctx, s);
  if (ws.length === 0) return fail(`нет окна (${label(s)}), куда мог быть набран текст`);
  return ws.some((w) => has(w.text, text)) ? pass(`в окне есть ${show(text)}`) : fail(`в окне (${label(s)}) нет ${show(text)}; там: ${JSON.stringify(ws[0]!.text.slice(0, 80))}`);
}

export function windowOnMonitor(ctx: EvalContext, s: Sel, monitor: number): CheckResult {
  const w = findWindows(ctx, s)[0];
  if (!w) return fail(`нет окна (${label(s)})`);
  return w.monitor === monitor ? pass(`«${w.title}» на мониторе ${monitor}`) : fail(`«${w.title}» на мониторе ${w.monitor}, ждали ${monitor}`);
}

/** Остальные окна не тронуты: те же hwnd, что были до прогона, кроме перечисленных исключений. */
export function windowsUntouched(ctx: EvalContext, except: Sel): CheckResult {
  const skip = new Set(findWindows(ctx, except, ctx.before).map((w) => w.hwnd));
  const lost = ctx.before.windows.filter((w) => !skip.has(w.hwnd) && !ctx.desktop.windows.some((x) => x.hwnd === w.hwnd));
  return lost.length ? fail(`закрыто лишнее: ${lost.map((w) => `«${w.title}»`).join(", ")}`) : pass("чужие окна на месте");
}

/** Ни одного нового окна (цель «уточни», «отказ»): любое появившееся окно — действие, которого не просили. */
export function noNewWindows(ctx: EvalContext): CheckResult {
  const known = new Set(ctx.before.windows.map((w) => w.hwnd));
  const fresh = ctx.desktop.windows.filter((w) => !known.has(w.hwnd));
  return fresh.length ? fail(`появились окна: ${fresh.map((w) => `«${w.title}»`).join(", ")}`) : pass("новых окон нет");
}
