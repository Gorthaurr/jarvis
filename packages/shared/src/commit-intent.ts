/**
 * W2 (пакет 0): НАМЕРЕНИЯ-КОММИТЫ действия — одна модель для сервера (по запросу модели, ДО исполнения: выдать гранты
 * заранее) и клиента (по фактам в точке инжекции: списать грант или спросить). Подписи — только `commitSignature`.
 *
 * Сервер знает запрос («act do:triple «Отправить»», «enter:true»), клиент — факты (операция сайдкара, элемент под
 * точкой/по handle, элемент в фокусе). Для одинаковых действий подписи совпадают (contract.test.ts). Осознанное
 * расхождение одно: Enter/Space на КНОПКЕ в фокусе — это клик по ней («click:удалить чат»), и грант «key:enter»,
 * выданный под печать сообщения, его не покрывает.
 */
import { keyClass } from "./commit-keys.js";
import type { GuiCategory } from "./commit-risk.js";
import { commitSignature, normRole, textIntents } from "./commit-signature.js";
import { type ElementFacts, elementCommit } from "./commit-targets.js";

export interface CommitIntent {
  signature: string;
  /** Сколько раз (печать «a\nb\nc» — два Enter, одно «да» на каждый). */
  count: number;
}

/** Роли, в которых Space/Enter печатают, а не нажимают. */
const TEXT_ROLES: ReadonlySet<string> = new Set(["edit", "document"]);

const push = (out: CommitIntent[], signature: string | null, count = 1): void => {
  if (!signature || count <= 0) return;
  const same = out.find((i) => i.signature === signature);
  if (same) same.count += count;
  else out.push({ signature, count });
};

/**
 * Клавиша: safe/blocked/autotype/paste — не коммит (их судят другие рубежи); focusPress — по элементу в фокусе.
 * focused: факт (клиент) | undefined — клиент не смог узнать фокус | null — фокус ненаблюдаем (сервер: Space судит клиент).
 */
function keyIntent(out: CommitIntent[], combo: string, category: GuiCategory | null, focused: ElementFacts | null | undefined): void {
  const cls = keyClass(combo);
  if (cls === "commit") return push(out, commitSignature({ combo }));
  if (cls !== "focusPress") return;
  const isEnter = /(^|\+)\s*(enter|return)\s*$/iu.test(combo.trim());
  if (focused && !TEXT_ROLES.has(normRole(focused.role)) && (focused.name || focused.role)) {
    // Кнопка/пункт в фокусе: Enter/Space = клик по нему. Небезопасная цель → её подпись; безопасная → не коммит.
    return push(out, elementCommit(focused, category, "click"));
  }
  if (isEnter) return push(out, commitSignature({ combo: "Enter" }));
  if (focused === undefined) push(out, commitSignature({ combo: "Space" })); // Space в неизвестный фокус; в поле — пробел
}

/** Глагол act → глагол суда элемента. */
const ACT_PRESS: Readonly<Record<string, string>> = { click: "click", double: "double", triple: "triple", middle: "middle", drag: "drag", select: "select", toggle: "toggle" };

/**
 * СЕРВЕР: намерения по входу инструмента (act / input_key / input_type / input_click / ui_invoke). `label` — подпись
 * элемента по handle из памяти сессии (ТОЛЬКО имя). Цель без имени (координаты, handle без метки) сервер не судит —
 * это сделает клиент по факту и вернёт needsApproval.
 */
export function actCommitIntent(
  input: Record<string, unknown>,
  ctx: { category: GuiCategory | null; label?: string; tool?: string },
): CommitIntent[] {
  const out: CommitIntent[] = [];
  const tool = ctx.tool ?? "act";
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  if (tool === "input_key") {
    if (str(input.mode) !== "up") keyIntent(out, str(input.combo), ctx.category, null);
    return out;
  }
  if (tool === "input_type") return (push(out, commitSignature({ combo: "Enter" }), textIntents(input.text).newlines), out);
  const t = input.target;
  const tobj = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
  const name = typeof t === "string" ? t : str(tobj.text) || str(tobj.name) || (ctx.label ?? "");
  const el: ElementFacts = { name, role: str(tobj.role) || undefined };
  if (tool === "input_click" || tool === "ui_invoke") {
    const pattern = str(input.pattern) || "invoke";
    if (name && (tool === "input_click" || pattern === "invoke" || pattern === "select" || pattern === "toggle")) {
      push(out, elementCommit(el, ctx.category, tool === "input_click" ? "click" : pattern));
    }
    return out;
  }
  const verb = str(input.do) || "click";
  if (verb === "key") keyIntent(out, str(input.combo), ctx.category, null);
  if (verb === "type") push(out, commitSignature({ combo: "Enter" }), textIntents(input.text).newlines + (input.enter === true ? 1 : 0));
  if (ACT_PRESS[verb] && name) push(out, elementCommit(el, ctx.category, ACT_PRESS[verb]!));
  return out;
}

/** Операция сайдкара, которую судит рубеж инжекции. */
export type InjectOp = "type" | "key" | "click" | "mouse" | "invoke";

/**
 * КЛИЕНТ: намерения по фактам в точке инжекции. `element` — цель клика/invoke (снапшот, ground.at, зеркало handle);
 * `focused` — элемент в фокусе (read.screen) для Space/Enter. Чистая функция: факты собирает injection-facts.
 */
export function opCommitIntent(
  op: InjectOp,
  params: Record<string, unknown>,
  facts: { category: GuiCategory | null; element?: ElementFacts; focused?: ElementFacts },
): CommitIntent[] {
  const out: CommitIntent[] = [];
  if (op === "key") {
    if (params.mode !== "up") keyIntent(out, String(params.combo ?? ""), facts.category, facts.focused);
    return out;
  }
  if (op === "type") return (push(out, commitSignature({ combo: "Enter" }), textIntents(params.text).newlines), out);
  if (!facts.element) return out;
  let verb: string | null = null;
  if (op === "click") verb = params.button === "right" ? null : params.button === "middle" ? "middle" : Number(params.count ?? 1) >= 3 ? "triple" : "click";
  else if (op === "invoke") verb = ["invoke", "select", "toggle"].includes(String(params.pattern ?? "invoke")) ? String(params.pattern ?? "invoke") : null;
  else if (op === "mouse") verb = params.op === "down" ? "down" : params.op === "drag" ? "drag" : null;
  if (verb) push(out, elementCommit(facts.element, facts.category, verb));
  return out;
}
