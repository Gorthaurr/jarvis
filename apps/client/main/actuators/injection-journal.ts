/**
 * W2 П2 (§0): ЖУРНАЛ ИНЖЕКЦИЙ для рубежа секретов — что РЕАЛЬНО ушло в сайдкар меняет память §0 (secret-memory.ts):
 * набранное в поле, память клика, удержание клавиш.
 *
 * Зовётся из inject.ts ПОСЛЕ суда всех судей: отказанная инжекция ничего не меняет — иначе отказанный клик сбросил
 * бы буфер, и карта, разрезанная вокруг него, прошла бы Луну. Сайдкар потом упал — считаем, что ушло (консервативно:
 * лишняя склейка даёт честный отказ, недостающая — пропуск карты).
 */
import * as electron from "electron";
import type { InjectOp } from "@jarvis/shared";
import { inputBuffer } from "./input-buffer.js";
import { type ClickMemory, effectiveCombo, holdKeys, markEvent, mirrorEntry, newEpoch, syncSecretState } from "./secret-memory.js";
import { elementLabel, isSecretElement, keyEffect } from "./secret-signs.js";

function memoryOf(handle: unknown, now: number): ClickMemory | null {
  const e = mirrorEntry(handle);
  if (!e) return null;
  const secret = isSecretElement(e);
  const label = elementLabel(e) || (secret ? "поле •••" : e.role);
  return { secret, label, ...(e.pid !== undefined ? { pid: e.pid } : {}), at: now };
}

function clipboardText(): string {
  try {
    return electron.clipboard?.readText() ?? "";
  } catch {
    return "";
  }
}

function noteText(text: string, now: number): void {
  // Enter/Tab внутри текста — то же, что клавиша: поле могло смениться (отправка, переход к следующему полю).
  const chunks = text.split(/[\n\t]/u);
  if (chunks.length > 1) newEpoch();
  inputBuffer.append(chunks[chunks.length - 1] ?? "", now);
}

function noteKey(combo: string, mode: unknown, now: number): void {
  if (mode === "up") {
    holdKeys(combo, false);
    return;
  }
  const effect = keyEffect(effectiveCombo(combo));
  if (mode === "down") holdKeys(combo, true);
  if (effect.kind === "char") inputBuffer.append(effect.ch, now);
  else if (effect.kind === "backspace") inputBuffer.backspace();
  else if (effect.kind === "paste") inputBuffer.append(clipboardText(), now);
  else if (effect.kind !== "keep") newEpoch();
}

function noteInvoke(params: Record<string, unknown>, now: number): void {
  const pattern = String(params.pattern ?? "invoke");
  if (pattern === "scroll") return;
  if (pattern !== "setValue") return newEpoch(memoryOf(params.handle, now));
  // SetValue ЗАМЕНЯЕТ содержимое поля: в эпохе — ровно новое значение (печать следом склеится с ним).
  inputBuffer.reset();
  inputBuffer.append(String(params.value ?? ""), now);
}

/** Инжекция ПРОШЛА рубеж и уходит в сайдкар: обновить набранное, память клика, удержание. */
export function noteInjected(op: InjectOp, params: Record<string, unknown>, now = Date.now()): void {
  syncSecretState(now);
  markEvent(now);
  if (op === "type") noteText(String(params.text ?? ""), now);
  else if (op === "key") noteKey(String(params.combo ?? ""), params.mode, now);
  else if (op === "invoke") noteInvoke(params, now);
  else if (op === "click") newEpoch(params.handle !== undefined ? memoryOf(params.handle, now) : null);
  else if (op === "mouse" && (params.op === "down" || params.op === "drag")) newEpoch();
}
