/**
 * W2 П2 (§0): ПОЛЕ ПОД ПЕЧАТЬЮ — пароль/код или нет. Признаки:
 *  1) память последнего клика (цель по зеркалу handle: `•••`, подсказка name/automationId) — пока фокус в той же
 *     программе (передний план по pid цели; не знаем передний план — память действует);
 *  2) элемент в фокусе (`read.screen`, первая строка): «[ЗАЩИЩЕНО]» (UIA IsPassword) или подсказка в имени поля.
 * Ни того, ни другого (UIA-таймаут Electron/Qt) → `known:false`: признак поля пропускается с пометкой в журнале —
 * решение №8 плана (fail-open ТОЛЬКО по полю; Луна действует всегда: блок любой печати хуже).
 *
 * Предпроверка всего текста (preflight) и первый кусок печати/Ctrl+V той же операции — один `read.screen`: вердикт
 * предпроверки живёт до смены эпохи фокуса и ≤ 3 с и годится лишь для текста, который в ней судился.
 */
import { type FocusedLine, createLogger, looksLikeSecretField } from "@jarvis/shared";
import type { InjectionFacts } from "./injection-facts.js";
import { inputBuffer } from "./input-buffer.js";
import { clickMemory, forgetClick } from "./secret-memory.js";
import { isEditLike } from "./secret-signs.js";

const log = createLogger("actuator:secret");

export interface FieldVerdict {
  secret: boolean;
  /** Чем опознано (для текста отказа): «клик в «Пароль»», «в фокусе «PIN»». */
  why?: string;
  /** Хоть один признак поля был доступен. */
  known: boolean;
}

export const PREFLIGHT_TTL_MS = 3_000;
let pre: { epoch: number; at: number; text: string; line: FocusedLine | null } | null = null;

async function focusedLine(facts: InjectionFacts, text: string | undefined, preflight: boolean): Promise<FocusedLine | null> {
  const now = Date.now();
  if (!preflight && text !== undefined && pre && pre.epoch === inputBuffer.epoch && now - pre.at <= PREFLIGHT_TTL_MS && pre.text.includes(text)) {
    return pre.line;
  }
  const line = await facts.focused();
  if (preflight && text !== undefined) pre = { epoch: inputBuffer.epoch, at: now, text, line };
  return line;
}

/** Фокус всё ещё в программе, где кликнули (передний план по pid). Не знаем — считаем, что да. */
async function sameProgram(facts: InjectionFacts, pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return true;
  const fg = (await facts.rawWindows())?.find((w) => w.foreground);
  return !fg || fg.pid === pid;
}

export interface FieldOpts {
  /** Спросить элемент в фокусе (read.screen). false — только бесплатные признаки (поцифровые key: цена UIA на клавишу). */
  focused: boolean;
  /** Что печатаем (для переиспользования вердикта предпроверки). */
  text?: string;
  preflight?: boolean;
}

export async function fieldVerdict(facts: InjectionFacts, opts: FieldOpts): Promise<FieldVerdict> {
  const mem = clickMemory();
  if (mem?.secret) {
    if (await sameProgram(facts, mem.pid)) return { secret: true, why: `клик в «${mem.label}»`, known: true };
    forgetClick(); // фокус ушёл в другую программу — память о чужом поле больше не про эту печать
  }
  if (!opts.focused) return { secret: false, known: mem !== null };
  const line = await focusedLine(facts, opts.text, opts.preflight === true);
  if (line && (line.secret || (isEditLike(line.role) && looksLikeSecretField(line.name)))) {
    return { secret: true, why: `в фокусе «${line.name || line.role}»${line.secret ? " [ЗАЩИЩЕНО]" : ""}`, known: true };
  }
  const known = line !== null || mem !== null;
  if (!known) log.warn("§0: признак поля неизвестен (read.screen не ответил, клика не было) — поле не проверено, Луна проверена");
  return { secret: false, known };
}

/** Тесты: забыть вердикт предпроверки. */
export function resetFieldCache(): void {
  pre = null;
}
