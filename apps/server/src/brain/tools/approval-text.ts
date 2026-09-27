/**
 * W2 (П3, S-2 №16): ТЕКСТ вопроса владельцу §14 строит СЕРВЕР. Строки с экрана (заголовок окна, набранное, имя
 * элемента) — недоверенные данные: без кавычек и переводов строки (не притворятся нашей разметкой модалки и не
 * «продолжат» вопрос своей строкой), с капом длины и с префиксом роли («Окно: …», «Набрано: …»).
 */
import type { CommitGrant } from "@jarvis/protocol";

/** Очистить недоверенную строку для модалки: без кавычек/переводов строки/угловых скобок, ≤ max символов. */
export function cleanUntrusted(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\r\n\t\u2028\u2029]+/gu, " ")
    .replace(/[«»"'`„“”‘’<>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

/** Наша строка (с нашими кавычками): только одной строкой и с капом — недоверенные части в ней уже очищены. */
const oneLine = (s: string, max: number): string => s.replace(/[\r\n\u2028\u2029]+/gu, " ").slice(0, max);

export interface QuestionParts {
  /** Где: «программе telegram (мессенджер)», «браузере (мессенджер/почта) на mail.google.com» — части уже очищены. */
  where: string;
  /** Что: описания действий (describeSignature — имя элемента в них уже очищено). */
  what: string[];
  windowTitle?: string;
  pendingText?: string;
  /** Текст, который модель просит напечатать (печать + Enter) — владелец видит, ЧТО уйдёт. */
  typed?: string[];
  /** Сделанные шаги серии (повтор со шага k+1). */
  doneSteps?: number;
}

/** Вопрос §14 одной строкой-абзацем: что, где, в каком окне, что набрано. */
export function approvalQuestion(p: QuestionParts): string {
  const lines = [`Необратимое действие в ${oneLine(p.where, 120)}: ${p.what.map((w) => oneLine(w, 100)).join("; ")}.`];
  const title = cleanUntrusted(p.windowTitle, 60);
  if (title) lines.push(`Окно: ${title}.`);
  for (const t of p.typed ?? []) {
    const c = cleanUntrusted(t, 200);
    if (c) lines.push(`Текст: ${c}`);
  }
  const pending = cleanUntrusted(p.pendingText, 200);
  if (pending) lines.push(`Набрано: ${pending}`);
  if (p.doneSteps && p.doneSteps > 0) lines.push(`Шаги 1–${p.doneSteps} уже сделаны; продолжу с шага ${p.doneSteps + 1}.`);
  lines.push("Подтвердить?");
  return lines.join("\n");
}

/** Сложить гранты с одинаковыми (подпись, процесс, окно, хост): кратность суммируется. */
export function mergeGrants(grants: readonly CommitGrant[]): CommitGrant[] {
  const out: CommitGrant[] = [];
  for (const g of grants) {
    const same = out.find((o) => o.signature === g.signature && o.process === g.process && o.hwnd === g.hwnd && o.host === g.host);
    if (same) same.count += g.count;
    else out.push({ ...g });
  }
  return out;
}
