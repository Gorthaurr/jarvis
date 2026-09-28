/**
 * W2 (П3, S-2, поправки №5, №16): отправить команду клиенту с одобрением §14 — ОДИН вопрос и ОДИН повтор.
 *
 * Клиентский рубеж судит по ФАКТУ (найденный элемент, реальный процесс под точкой, фокус) и без гранта отвечает
 * `denied` + `data.needsApproval`. Тогда:
 *  - ничего не инжектировано → вопрос владельцу. Текст строит СЕРВЕР: категорию пересчитывает по процессу (клиентской
 *    не верит), заголовок окна и набранное чистит и капает (approval-text.ts). После «да» — один повтор с грантом
 *    `{signature, process, hwnd}`; web с безопасной вкладкой — грант без вопроса (gui-browser-gate.ts);
 *  - `skill.execute` остановлен на шаге k > 0 → повтор только `steps.slice(k)` (шаги 1..k уже сделаны) с грантами,
 *    сузёнными до оставшихся шагов (не больше, чем владелец одобрил серии);
 *  - часть действия уже ушла (`stepActionInjected`) → `uncertain` без повтора: «набрал, но не отправил»;
 *  - отказ владельца → `gateDeclined`; повторный needsApproval → честная ошибка, третьего вопроса нет.
 * Готовый ToolResult (`{tool}`) отдаётся ДО `actResult`; код `denied` actResult не трогает.
 *
 * Зовут: generic-путь `dispatchTool`, `skill_execute` и `input_batch` (handlers/skills.ts).
 */
import type { ActionCommand, ActionResult, CommitGrant, NeedsApproval } from "@jarvis/protocol";
import { canonicalProcess, guiProcessCategory, textIntents } from "@jarvis/shared";
import { approvalQuestion, cleanUntrusted, mergeGrants } from "./approval-text.js";
import { batchIntents, narrowGrants } from "./batch-commit.js";
import { confirmDeclineText, err, gateDeclined } from "./dispatch-util.js";
import type { ToolContext, ToolResult } from "./dispatch.js";
import { browserPlace, browserWhere } from "./gui-browser-gate.js";
import { approvalFor } from "./gui-gate.js";
import { describeSignature } from "./gui-intents.js";
import { eduGuiGranted } from "./task-grant.js";

export type ApprovedSend = { result: ActionResult } | { tool: ToolResult };

/** Запрос одобрения от клиентского рубежа (форма протокола NeedsApproval); иначе null. */
export function needsApprovalOf(r: ActionResult): NeedsApproval | null {
  if (r.ok || r.error?.code !== "denied") return null;
  const na = (r.data as { needsApproval?: Partial<NeedsApproval> } | undefined)?.needsApproval;
  return na && typeof na.signature === "string" && na.signature && typeof na.process === "string" ? (na as NeedsApproval) : null;
}

const stepOf = (cmd: ActionCommand, r: ActionResult): number => (cmd.kind === "skill.execute" && typeof r.stepIndex === "number" ? r.stepIndex : 0);
const seriesName = (cmd: ActionCommand): string => (cmd.kind !== "skill.execute" ? "Действие" : cmd.skillId.startsWith("adhoc-batch-") ? "Берст" : `Навык «${cmd.skillId}»`);

/** Текст, который уйдёт с этим Enter (печать команды или шага k). */
function typedOf(cmd: ActionCommand, k: number): string | undefined {
  if (cmd.kind === "input.type") return cmd.text;
  if (cmd.kind === "gui.act") return cmd.do === "type" ? cmd.text : undefined;
  const s = cmd.kind === "skill.execute" ? cmd.steps[k] : undefined;
  return s?.action === "input.type" && typeof s.params?.text === "string" ? s.params.text : undefined;
}

/** Кратность гранта повтора: одно «да» на каждый Enter печатаемого текста (так и в вопросе). */
function retryCount(cmd: ActionCommand, k: number, signature: string): number {
  if (signature !== "key:enter") return 1;
  return Math.max(1, textIntents(typedOf(cmd, k)).newlines + (cmd.kind === "gui.act" && cmd.enter === true ? 1 : 0));
}

function withPartial(out: ToolResult, k: number): ToolResult {
  if (k > 0) out.partialSteps = k;
  return out;
}

/** Спросить владельца (или выдать грант без вопроса для безопасной вкладки). */
async function decide(ctx: ToolContext, cmd: ActionCommand, na: NeedsApproval, k: number): Promise<{ grant: CommitGrant } | { tool: ToolResult }> {
  const procName = cleanUntrusted(na.process, 40);
  const cat = guiProcessCategory(na.process, na.windowTitle); // категорию считаем сами — клиентской не верим
  // Процесс гранта: канон (как ищет клиент по реальному процессу) или ровно то, что прислал клиент (незнакомая программа).
  const process = canonicalProcess(na.process) ?? na.process;
  const grant: CommitGrant = { signature: na.signature, process, count: retryCount(cmd, k, na.signature), ...(typeof na.hwnd === "number" ? { hwnd: na.hwnd } : {}) };
  let where = `программе ${procName}${cat ? ` (${cat.human})` : ""}`;
  if (cat?.category === "web") {
    const place = await browserPlace(ctx, { process, title: na.windowTitle });
    if (place.host) grant.host = place.host;
    if (place.safe || eduGuiGranted(ctx, place, [na.signature])) return { grant };
    where = browserWhere(place);
  }
  const what = describeSignature(na.signature, cat?.category ?? null);
  const step = cmd.kind === "skill.execute" ? `${seriesName(cmd)}, шаг ${k + 1}: ` : "";
  if (!ctx.confirm) return { tool: withPartial(err(`${step}${what} в ${where} — нужно подтверждение владельца (§14), а канал недоступен. Не сделано.`), k) };
  const typed = typedOf(cmd, k);
  const q = approvalQuestion({ where, what: [`${step}${what}`], windowTitle: na.windowTitle, pendingText: na.pendingText, typed: typed ? [typed] : [], doneSteps: k });
  const gate = await ctx.confirm(q, "irreversible");
  if (!gate.approved) return { tool: withPartial(gateDeclined(confirmDeclineText(gate.outcome, `${step}${what} в ${where}`), gate.outcome), k) };
  return { grant };
}

/** Повтор с грантом: та же команда (или шаги с k) + гранты, срок — заново от таймаута команды. */
function retryCommand(ctx: ToolContext, cmd: ActionCommand, grant: CommitGrant, k: number, timeoutMs: number): ActionCommand {
  const prior = cmd.approval?.grants ?? [];
  if (cmd.kind === "skill.execute") {
    const kept = k > 0 ? narrowGrants(prior, batchIntents(ctx, cmd.steps, k)) : prior;
    return { ...cmd, steps: cmd.steps.slice(k), approval: approvalFor(mergeGrants([...kept, grant]), timeoutMs) };
  }
  return { ...cmd, approval: approvalFor(mergeGrants([...prior, grant]), timeoutMs) };
}

/** Номер шага повтора — в нумерацию исходной серии (провал на j-м шаге хвоста = шаг k + j). */
function shiftStep(r: ActionResult, cmd: ActionCommand, k: number): ActionResult {
  if (cmd.kind !== "skill.execute" || k === 0 || r.ok) return r;
  return { ...r, stepIndex: (typeof r.stepIndex === "number" ? r.stepIndex : 0) + k };
}

/** Часть действия ушла, коммит упёрся в рубеж: исход частичный — повтор дал бы дубль набранного. */
function injectedOutcome(cmd: ActionCommand, na: NeedsApproval, k: number): ToolResult {
  const what = describeSignature(na.signature, guiProcessCategory(na.process, na.windowTitle)?.category ?? null);
  const step = cmd.kind === "skill.execute" ? `${seriesName(cmd)} остановлен на шаге ${k + 1} («${cmd.steps[k]?.action ?? "?"}»): ` : "";
  const done = k > 0 ? ` Сделанные ${k} шагов не откатываются.` : "";
  const out = err(
    `${step}набрал, но не отправил — ${what} требует «да» владельца (§14). Часть действия УЖЕ ушла в GUI: НЕ повторяй вслепую ` +
      `(дубль набранного), сверь состояние (look) и сделай отправку отдельным действием — владелец её подтвердит.${done}`,
  );
  out.uncertain = true;
  if (cmd.kind === "skill.execute") out.partialInjected = true;
  return withPartial(out, k);
}

export async function sendActionApproved(ctx: ToolContext, cmd: ActionCommand, timeoutMs: number): Promise<ApprovedSend> {
  const r = await ctx.session.sendAction(cmd, timeoutMs);
  const na = needsApprovalOf(r);
  if (!na) return { result: r };
  const k = stepOf(cmd, r);
  if (r.stepActionInjected === true) return { tool: injectedOutcome(cmd, na, k) };
  const decision = await decide(ctx, cmd, na, k);
  if ("tool" in decision) return decision;
  const r2 = shiftStep(await ctx.session.sendAction(retryCommand(ctx, cmd, decision.grant, k, timeoutMs), timeoutMs), cmd, k);
  const na2 = needsApprovalOf(r2);
  if (!na2) return { result: r2 };
  const k2 = stepOf(cmd, r2);
  if (r2.stepActionInjected === true) return { tool: injectedOutcome(cmd, na2, k2) };
  const what = describeSignature(na2.signature, guiProcessCategory(na2.process, na2.windowTitle)?.category ?? null);
  const at = cmd.kind === "skill.execute" ? `${seriesName(cmd)}, шаг ${k2 + 1}: ` : "";
  return {
    tool: withPartial(
      err(`${at}${what} снова требует подтверждения владельца — третий раз не спрашиваю, это действие НЕ сделано. Сделай его отдельным вызовом (act) — владелец подтвердит.`),
      k2,
    ),
  };
}
