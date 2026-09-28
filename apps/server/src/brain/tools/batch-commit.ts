/**
 * W2 (П3, G-1/S-3): §14 для СЕРИЙ — input_batch и skill_execute судятся по ЗАПОЛНЕННЫМ шагам ДО отправки.
 *
 * Раньше серия спрашивала владельца только по флагу навыка `needsReview`: берст [печать «привет», «Отправить»] в
 * Telegram уходил человеку без вопроса, а клиентский рубеж реплея спросить не мог (у реплея нет канала к владельцу).
 * Теперь: шаги с известной меткой (роль/имя цели, handle из снимка, клавиша, печать с переводом строки) → подписи
 * `actCommitIntent` в процессе шага (`app.focus`/`app.launch` меняют программу по ходу серии) → ОДИН вопрос с перечнем
 * действий и печатаемого текста → гранты с КРАТНОСТЬЮ в `skill.execute` (два «Отправить» — count 2). Немые шаги
 * (координаты, handle без снимка, незнакомая программа) судит клиент по факту и вернёт needsApproval со шагом k.
 */
import type { CommitApproval, CommitGrant, SkillStep } from "@jarvis/protocol";
import { SKILL_EXECUTE_SERVER_TIMEOUT_MS } from "@jarvis/protocol";
import { approvalQuestion, mergeGrants } from "./approval-text.js";
import { confirmDeclineText, err, gateDeclined } from "./dispatch-util.js";
import type { ToolContext, ToolResult } from "./dispatch.js";
import { handleInfo, targetHandle } from "./gate-memory.js";
import { browserPlace, browserWhere } from "./gui-browser-gate.js";
import { approvalFor } from "./gui-gate.js";
import { type GuiWhere, describeSignature, resolveWhere, serverIntents, targetName } from "./gui-intents.js";
import { eduGuiGranted } from "./task-grant.js";

export interface StepIntent {
  /** Индекс шага (с 0). */
  step: number;
  signature: string;
  process: string;
  count: number;
  where: GuiWhere;
  display: string;
}

/** Шаг серии → вход инструмента, который судит `serverIntents` (та же форма, что у одиночного вызова). */
const STEP_TOOL: Readonly<Record<string, string>> = { "input.key": "input_key", "input.type": "input_type", "input.click": "input_click", "ui.invoke": "ui_invoke" };

function stepInput(tool: string, s: SkillStep): Record<string, unknown> {
  const p = s.params ?? {};
  if (tool === "input_key") return { combo: p.combo, mode: p.mode };
  if (tool === "input_type") return { text: p.text };
  return tool === "ui_invoke" ? { target: s.target, pattern: p.pattern ?? "invoke" } : { target: s.target };
}

/** Намерения-коммиты шагов с индекса `from` (программа отслеживается с начала серии). */
export function batchIntents(ctx: ToolContext, steps: readonly SkillStep[], from = 0): StepIntent[] {
  const sys = ctx.systemContext?.() ?? "";
  const sess = ctx.session as unknown as object;
  let where = resolveWhere(null, sys);
  const out: StepIntent[] = [];
  steps.forEach((s, i) => {
    if (s.action === "app.focus" || s.action === "app.launch") where = resolveWhere(String(s.params?.app ?? "").trim() || "?", sys);
    if (s.action === "browser.open") where = resolveWhere("?", sys); // браузер по умолчанию неизвестен — судит клиент
    const tool = STEP_TOOL[s.action];
    if (!tool || i < from || !where.process) return;
    const input = stepInput(tool, s);
    const mem = handleInfo(sess, targetHandle(s.target));
    const display = targetName(input, mem);
    for (const it of serverIntents(tool, input, where, mem)) out.push({ step: i, signature: it.signature, process: where.process, count: it.count, where, display });
  });
  return out;
}

export function grantsOf(intents: readonly StepIntent[], host?: string): CommitGrant[] {
  return mergeGrants(intents.map((i) => ({ signature: i.signature, process: i.process, count: i.count, ...(host && i.where.category === "web" ? { host } : {}) })));
}

/** Оставить из одобренных грантов только нужные шагам с k (повтор серии со шага k — не больше, чем одобрено). */
export function narrowGrants(approved: readonly CommitGrant[], need: readonly StepIntent[]): CommitGrant[] {
  return approved.flatMap((g) => {
    const n = need.filter((i) => i.signature === g.signature && i.process === g.process).reduce((a, i) => a + i.count, 0);
    return n > 0 ? [{ ...g, count: Math.min(g.count, n) }] : [];
  });
}

/**
 * Вопрос по серии ДО отправки. `label` — «берст»/«навык «X»». Нет коммитов с известной меткой → {} (решит клиент);
 * web с безопасным хостом — грант без вопроса; «нет» владельца → `denied` (ничего не ушло).
 */
export async function batchGate(ctx: ToolContext, steps: readonly SkillStep[], label: string): Promise<{ denied?: ToolResult; approval?: CommitApproval; asked?: boolean }> {
  const intents = batchIntents(ctx, steps);
  if (intents.length === 0) return {};
  const web = intents.find((i) => i.where.category === "web");
  const place = web ? await browserPlace(ctx, { process: web.process, title: web.where.title }) : undefined;
  const approval = approvalFor(grantsOf(intents, place?.host), SKILL_EXECUTE_SERVER_TIMEOUT_MS);
  // Учебное дело поручено владельцем (task-grant.ts): шаг-LMS-коммит в учебной вкладке идёт без вопроса, остальное — как было.
  const ask = intents.filter((i) => i.where.category !== "web" || !(place?.safe || (place && eduGuiGranted(ctx, place, [i.signature]))));
  if (ask.length === 0) return { approval };
  const what = ask.map((i) => `шаг ${i.step + 1} — ${describeSignature(i.signature, i.where.category, i.display)}${i.count > 1 ? ` ×${i.count}` : ""}`);
  const places = [...new Set(ask.map((i) => (i.where.category === "web" && place ? browserWhere(place) : `программе ${i.where.display} (${i.where.human})`)))];
  const where = `${places.join(" и ")}, ${label}`;
  if (!ctx.confirm) return { denied: err(`${label}: ${what.join("; ")} — нужно подтверждение владельца (§14), а канал недоступен. Ничего не сделано.`) };
  const typed = steps.filter((s) => s.action === "input.type" && typeof s.params?.text === "string").map((s) => String(s.params!.text));
  const gate = await ctx.confirm(approvalQuestion({ where, what, typed }), "irreversible");
  if (!gate.approved) return { denied: gateDeclined(confirmDeclineText(gate.outcome, `${label}: ${what.join("; ")}`), gate.outcome) };
  return { approval, asked: true };
}
