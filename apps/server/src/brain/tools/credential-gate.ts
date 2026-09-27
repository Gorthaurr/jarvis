/**
 * W2: шов §0 в `dispatchTool` — пролог гарда учётных данных и эпилог памяти целей (владелец — П3).
 *
 * 🔴 УЧЁТНЫЕ ДАННЫЕ НЕ ВВОДИМ (§0 принцип 5) — гард стоит НАД исполнением, а не в шести хендлерах: печатающих путей
 * много (input_type, browser_act{type}, browser_batch, web_act{type}, ui_invoke{setValue}, system_clipboard{write},
 * act{type|set}, шаги input_batch, вставка Ctrl+V), подключать проверку к каждому — гарантированно забыть один. Отказ —
 * ОШИБКОЙ (`isError:true` не даёт петле взвести «сделано»); предупреждение (признака поля нет) — к УСПЕШНОМУ результату.
 *
 * W2 П3 (S-5, S-6, G-3(3)(5)): поле по голому handle видно из памяти снимка (подпись и «•••»); печать в фокус
 * (input_type, act type без цели, шаг берста без цели) и вставка наследуют НАВЕДЁННУЮ цель сессии; вставка судится
 * по содержимому буфера обмена, которое положил Джарвис. Это ранний отказ до отправки; главный рубеж — клиент (П2).
 */
import { type CredentialVerdict, type FocusFacts, checkCredentialInput } from "./credential-guard.js";
import { aimedTarget, handleInfo, lastClipboard, noteGateTarget } from "./gate-memory.js";
import { refFieldInfo } from "./handlers/browser.js";
import type { ToolContext, ToolResult } from "./dispatch.js";

const sessionOf = (ctx: ToolContext): object | undefined => ctx.session as unknown as object | undefined;

/** Пролог: вердикт ДО исполнения. `block` — честный отказ, инструмент не исполняется. */
export function credentialGate(name: string, input: Record<string, unknown>, ctx: ToolContext): CredentialVerdict {
  const sess = sessionOf(ctx);
  const aimed = aimedTarget(sess);
  const focus: FocusFacts = { hints: aimed?.hints ?? [], secret: aimed?.secret, clipboard: lastClipboard(sess) };
  return checkCredentialInput(
    name,
    input,
    (ref) => refFieldInfo(ctx, ref), // W1: подпись И признак secret из снимков browser_inspect
    (handle) => {
      const info = handleInfo(sess, handle);
      return info ? { hint: info.label || undefined, secret: info.secret } : undefined;
    },
    focus,
  );
}

/** Эпилог: запомнить наведённую цель/буфер обмена/ui_ground и дописать предупреждение к успешному результату. */
export function credentialGateNotes(name: string, input: Record<string, unknown>, ctx: ToolContext, out: ToolResult, verdict: CredentialVerdict): void {
  noteGateTarget(sessionOf(ctx), name, input, out.data);
  if (verdict.note && !out.isError) appendToolNote(out, verdict.note);
}

/** Дописать примечание в текст результата (content бывает и блоками — у зрения). */
export function appendToolNote(out: ToolResult, note: string): void {
  if (typeof out.content === "string") out.content = `${out.content}\n${note}`;
  else out.content = [...out.content, { type: "text", text: note }];
}
