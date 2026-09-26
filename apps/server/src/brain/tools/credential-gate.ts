/**
 * W2 (пакет 0): шов §0 в `dispatchTool` — пролог гарда учётных данных (вынесен из dispatch.ts без изменения поведения).
 *
 * 🔴 УЧЁТНЫЕ ДАННЫЕ НЕ ВВОДИМ (§0 принцип 5) — гард стоит НАД исполнением, а не в шести хендлерах: печатающих путей
 * много (input_type, browser_act{type}, browser_batch, web_act{type}, ui_invoke{setValue}, system_clipboard{write},
 * act{type|set}, шаги input_batch), подключать проверку к каждому — гарантированно забыть один. Отказ — ОШИБКОЙ
 * (`isError:true` не даёт петле взвести «сделано»); предупреждение (признака поля нет) — к УСПЕШНОМУ результату.
 *
 * Владелец после P0 — П3 (наследование наведённой цели, S-6, G-3).
 */
import { type CredentialVerdict, checkCredentialInput, lastActTarget, rememberActTarget } from "./credential-guard.js";
import { uiHandleLabel } from "./commit-gate.js";
import { refFieldInfo } from "./handlers/browser.js";
import type { ToolContext, ToolResult } from "./dispatch.js";

/** Пролог: вердикт ДО исполнения. `block` — честный отказ, инструмент не исполняется. */
export function credentialGate(name: string, input: Record<string, unknown>, ctx: ToolContext): CredentialVerdict {
  const sessKey = ctx.session as unknown as object | undefined;
  // Контроль-2 №2: печать act без цели наследует поле прошлого act (фокус там и остался).
  const typesIntoFocus = name === "act" && input.target === undefined && (input.do === "type" || input.do === "set");
  return checkCredentialInput(
    name,
    typesIntoFocus ? { ...input, target: lastActTarget(sessKey) } : input,
    (ref) => refFieldInfo(ctx, ref), // W1: подпись И признак secret из снимков browser_inspect
    (handle) => uiHandleLabel(sessKey, typeof handle === "string" ? Number(handle) : handle),
  );
}

/** Эпилог: запомнить цель act (для печати без цели) и дописать предупреждение к успешному результату. */
export function credentialGateNotes(name: string, input: Record<string, unknown>, ctx: ToolContext, out: ToolResult, verdict: CredentialVerdict): void {
  if (name === "act" && input.target !== undefined) rememberActTarget(ctx.session as unknown as object | undefined, input.target);
  if (verdict.note && !out.isError) appendToolNote(out, verdict.note);
}

/** Дописать примечание в текст результата (content бывает и блоками — у зрения). */
export function appendToolNote(out: ToolResult, note: string): void {
  if (typeof out.content === "string") out.content = `${out.content}\n${note}`;
  else out.content = [...out.content, { type: "text", text: note }];
}
