/**
 * W2 (П3): §14 для GUI-инструментов в `dispatchTool` — ВЫДАЧА ГРАНТОВ по запросу модели, до исполнения.
 *
 * §14 ГЕЙТ НЕОБРАТИМЫХ КЛИКОВ (причина №4 USER_SCENARIOS_2026-09-02): «Провести» в 1С, Enter в Telegram Desktop,
 * «Оплатить» в банк-клиенте. Место — программа из `app` у act (act сам фокусирует окно ПОСЛЕ гейта, H-S1) или
 * передний план живого снимка ПК; процесс — `canonicalProcess` («телега» → telegram). Что — `actCommitIntent` (та же
 * функция подписи, что у клиентского рубежа). Цель по handle судится именем из памяти снимка (S-1: handle — строка
 * в цели, память — по числу). Владелец сказал «да» → одобрение = гранты `{signature, process, count}` со сроком
 * «сейчас + таймаут команды»; грантов «по категории» нет. Процесс не распознан или цель немая (координаты, handle без
 * снимка) → вопроса заранее нет: клиент рассудит по факту и вернёт needsApproval (send-approved.ts).
 * Браузер через GUI — по живой вкладке (gui-browser-gate.ts): безопасный хост → грант без вопроса.
 *
 * Контракт вердикта: `denied` — готовый ToolResult (отказ/нет канала), команда не уходит; `approval` — гранты для
 * клиента (единственный канал «да» до рубежа инжекции; прежний флаг gui.act `commitApproved` удалён в интеграции W2).
 */
import type { CommitApproval, CommitGrant } from "@jarvis/protocol";
import { actionTimeoutMs } from "@jarvis/protocol";
import { ACTUATOR_KIND_BY_TOOL } from "@jarvis/tools";
import { approvalQuestion } from "./approval-text.js";
import { confirmDeclineText, err, gateDeclined } from "./dispatch-util.js";
import type { ToolContext, ToolResult } from "./dispatch.js";
import { handleInfo, targetHandle } from "./gate-memory.js";
import { browserPlace, browserWhere } from "./gui-browser-gate.js";
import { type GuiWhere, describeSignature, resolveWhere, serverIntents, targetName } from "./gui-intents.js";
import { eduGrantedFor } from "./task-grant.js";

export interface GuiGateVerdict {
  denied?: ToolResult;
  approval?: CommitApproval;
}

/** Инструменты, которые судит гейт GUI-коммитов. */
const GUI_GATED: ReadonlySet<string> = new Set(["ui_invoke", "input_key", "input_click", "act", "input_type"]);

/** Срок одобрения: сейчас + таймаут команды-носителя (одноразовость держит счётчик гранта). */
export function approvalFor(grants: CommitGrant[], timeoutMs: number): CommitApproval {
  return { grants, expiresAt: Date.now() + timeoutMs };
}

/** Где и что: место действия и намерения-коммиты запроса. Пусто — заранее спрашивать не о чем. */
export function guiPlan(name: string, input: Record<string, unknown>, ctx: ToolContext): { where: GuiWhere; intents: ReturnType<typeof serverIntents>; display: string } {
  const app = name === "act" && typeof input.app === "string" && input.app.trim() ? input.app.trim() : null;
  const where = resolveWhere(app, ctx.systemContext?.() ?? "");
  const mem = handleInfo(ctx.session as unknown as object, targetHandle(input.target));
  return { where, intents: serverIntents(name, input, where, mem), display: targetName(input, mem) };
}

/** Текст печати, который уйдёт вместе с Enter (владелец видит, ЧТО отправится). */
function typedText(name: string, input: Record<string, unknown>): string[] {
  const typing = name === "input_type" || (name === "act" && input.do === "type");
  return typing && typeof input.text === "string" && input.text.trim() ? [input.text] : [];
}

export async function guiGate(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<GuiGateVerdict> {
  if (!GUI_GATED.has(name)) return {};
  const { where, intents, display } = guiPlan(name, input, ctx);
  if (intents.length === 0 || !where.process) return {};
  const timeoutMs = actionTimeoutMs(ACTUATOR_KIND_BY_TOOL[name] ?? "");
  let host: string | undefined;
  let placeText = `программе ${where.display} (${where.human})`;
  if (where.category === "web") {
    const place = await browserPlace(ctx, { process: where.process, title: where.title });
    host = place.host;
    if (place.safe || eduGrantedFor(ctx.userId, place.category)) return { approval: approvalFor(grantsOf(intents, where.process, host), timeoutMs) };
    placeText = browserWhere(place);
  }
  const what = intents.map((i) => describeSignature(i.signature, where.category, display));
  if (!ctx.confirm) return { denied: err(`${name}: ${what.join("; ")} в ${placeText} — нужно подтверждение владельца (§14), а канал недоступен.`) };
  const gate = await ctx.confirm(approvalQuestion({ where: placeText, what, typed: typedText(name, input) }), "irreversible");
  if (!gate.approved) return { denied: gateDeclined(confirmDeclineText(gate.outcome, `${what.join("; ")} в ${placeText}`), gate.outcome) };
  return { approval: approvalFor(grantsOf(intents, where.process, host), timeoutMs) };
}

function grantsOf(intents: ReturnType<typeof serverIntents>, process: string, host?: string): CommitGrant[] {
  return intents.map((i) => ({ signature: i.signature, process, count: i.count, ...(host ? { host } : {}) }));
}
