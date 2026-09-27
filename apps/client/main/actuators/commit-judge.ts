/**
 * W2 П1 (решения №1–3): судья «commit» (§14) рубежа инжекции — по НАЙДЕННОМУ элементу и РЕАЛЬНОМУ процессу.
 *
 * Категория процесса цели (guiProcessCategory: рискованный, remote → только клавиши, браузер → web, UWP-хост — по
 * заголовку) × намерение по фактам (opCommitIntent: клавиши — allowlist, Space/Enter — по элементу в фокусе; клик,
 * invoke, `mouse down`, drag — по элементу; печать — переводы строк). Обычная программа — не судится. Процесс не
 * определён → кандидат в коммит (по строгому allowlist мессенджера) отклоняется честно. Устаревшая запись зеркала в
 * рискованной программе пересверяется (commit-recheck). Грант из области списывается; нет — denied + needsApproval
 * (мост/реплей/UI — отказ без вопроса). Почта: перевод строки в поле — абзац, не отправка.
 */
import { type CommitIntent, type ElementFacts, type GuiCategory, actCommitIntent, guiProcessCategory, keyClass, normRole, opCommitIntent } from "@jarvis/shared";
import type { InjectionCase, Judge, JudgeDenial } from "./injection-guard.js";
import { type Judged, approvalDenial, matchGrants, unknownProcessDenial } from "./commit-approval.js";
import { type CommitTarget, commitKind, commitTargets } from "./commit-target.js";
import { recheckElement } from "./commit-recheck.js";
import { isStale, noteInjected } from "./handle-mirror.js";
import { inputBuffer } from "./input-buffer.js";

const TEXT_ROLES: ReadonlySet<string> = new Set(["edit", "document"]);
const isEnter = (combo: unknown): boolean => /(^|\+)\s*(enter|return)\s*$/iu.test(String(combo ?? "").trim());

/** Намерения клавиатуры: remote — без фокуса (UIA внутрь сессии не видит); почта — Enter в поле = абзац. */
async function keyIntents(c: InjectionCase, t: CommitTarget, cat: { category: GuiCategory; human: string } | null): Promise<CommitIntent[]> {
  const category = cat?.category ?? "messenger";
  if (t.op === "type") return cat?.human === "почта" ? [] : opCommitIntent("type", t.params, { category });
  if (category === "remote") return actCommitIntent({ combo: t.params.combo, mode: t.params.mode }, { category, tool: "input_key" });
  const needsFocus = cat && keyClass(String(t.params.combo ?? "")) === "focusPress";
  const f = needsFocus ? await c.facts.focused() : null;
  const focused: ElementFacts | undefined = f ? { role: f.role, name: f.name } : undefined;
  if (cat?.human === "почта" && isEnter(t.params.combo) && focused && TEXT_ROLES.has(normRole(focused.role))) return [];
  return opCommitIntent("key", t.params, { category, ...(focused ? { focused } : {}) });
}

/** Намерения элемента; устаревшая запись в рискованной программе — по текущему имени. undefined — элемент изменился. */
async function elementIntents(t: CommitTarget, category: GuiCategory, risky: boolean): Promise<CommitIntent[] | undefined> {
  let el = (await t.element?.()) ?? {};
  if (risky && category !== "remote" && t.entry && t.proc && isStale(t.entry)) {
    const now = await recheckElement(t.entry, t.entry.pid ?? t.proc.pid);
    if (!now) return undefined;
    el = now;
  }
  return opCommitIntent(t.op, t.params, { category, element: el });
}

function pendingOf(c: InjectionCase): string {
  const typed = inputBuffer.recent(200);
  return c.op === "type" && c.preflight ? `${typed}${String(c.params.text ?? "").replace(/[\r\n]+$/u, "")}`.slice(-200) : typed;
}

export const commitJudge: Judge = async (c): Promise<JudgeDenial | null> => {
  const kind = commitKind(c);
  const touches = !(c.op === "mouse" && (c.params.op === "move" || c.params.op === "up"));
  if (!kind) {
    if (!c.preflight && touches) noteInjected(null);
    return null;
  }
  const judged: Judged[] = [];
  const targets = await commitTargets(c, kind);
  for (const t of targets) {
    const cat = t.proc ? guiProcessCategory(t.proc.process, t.proc.title) : undefined;
    if (cat === null) continue; // обычная программа — §14 не судит
    const category = cat?.category ?? "messenger"; // процесс неизвестен → строжайший allowlist
    const intents = kind === "element" ? await elementIntents(t, category, !!cat) : await keyIntents(c, t, cat ?? null);
    if (!intents) return { message: "§14: элемент по handle изменился с прошлого снапшота (или не нашёлся) — сними ui_snapshot заново; ничего не нажато." };
    if (intents.length && !t.proc) return unknownProcessDenial(intents[0]!);
    for (const intent of intents) judged.push({ intent, proc: t.proc!, category, human: cat!.human });
  }
  const m = matchGrants(c.scope, judged);
  if ("missing" in m) return approvalDenial(c.scope, m.missing, pendingOf(c));
  if (!c.preflight) {
    for (const [g, n] of m.take) g.count -= n; // одно «да» — одно действие
    for (const t of targets) noteInjected(t.proc?.pid ?? null); // записи зеркала этого процесса устарели
  }
  return null;
};
