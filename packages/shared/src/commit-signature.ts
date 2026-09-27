/**
 * W2 (пакет 0, решение №3): ПОДПИСЬ коммита и процесс гранта — одна функция на сервер и клиент.
 *
 * Одобрение владельца = грант {signature, process, hwnd?, count}. Сервер выдаёт его по ЗАПРОСУ модели («нажми
 * «Отправить» в телеге»), клиент списывает по ФАКТУ (найденный элемент, реальный процесс). Разойдись формулы — «да»
 * владельца не находилось бы (второй вопрос) или, хуже, подходило бы к другому действию. Поэтому подпись считает
 * только этот модуль, а стык закреплён табличным контракт-тестом (contract.test.ts).
 *
 * Правила: подпись элемента — ТОЛЬКО имя (без роли: сервер знает роль не всегда), сложенное (регистр, ё, пробелы,
 * кавычки); клавиши — каноническое комбо («Ctrl+Enter» ≡ «enter+ctrl»); процесс — каноническое имя по алиасам.
 */
import { canonicalCombo } from "./commit-keys.js";
import { BROWSER_PROCESSES, REMOTE_PROCESSES, appNameCandidates, riskyProcessCategory } from "./commit-risk.js";

/** Сложить имя элемента для подписи: NFKC, нижний регистр, ё→е, без невидимых символов и кавычек, ≤ 60 символов. */
export function foldLabel(name: unknown): string {
  return String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[​-‏⁠﻿]/gu, "")
    .replace(/[«»"'“”„`]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60);
}

/** Роль UIA без префикса «ControlType.» и в нижнем регистре (ground отдаёт «ControlType.Button», снапшот — «button»). */
export function normRole(role: unknown): string {
  return String(role ?? "").trim().replace(/^controltype\./iu, "").toLowerCase();
}

/** Подпись: клавиша → «key:ctrl+enter»; элемент → «click:отправить» или «click:?button» для безымянного. */
export function commitSignature(x: { combo: string } | { name?: string; role?: string }): string {
  if ("combo" in x) return `key:${canonicalCombo(x.combo)}`;
  const label = foldLabel(x.name);
  return label ? `click:${label}` : `click:?${normRole(x.role) || "element"}`;
}

/** Канон процессов, у которых несколько имён образа (новые/старые Teams и Outlook, редакции 1С). */
const PROCESS_CANON: ReadonlyArray<readonly [RegExp, string]> = [
  [/^1cv8/i, "1cv8"],
  [/^(ms-?teams|teams)$/i, "teams"],
  [/^(olk|hxoutlook|outlook)$/i, "outlook"],
  [/^vk ?teams$/i, "vkteams"],
];

/**
 * Канонический процесс из имени образа («Telegram.exe») или свободной строки модели («телега», «Telegram Desktop»).
 * Распознаётся только известное рубежу (рискованные, удалённый доступ, браузеры); прочее → null — сервер тогда
 * заранее не спрашивает, спросит клиент по реальному процессу (грантов «по категории» нет).
 */
export function canonicalProcess(nameOrApp: string | null | undefined): string | null {
  for (const cand of appNameCandidates(String(nameOrApp ?? ""))) {
    for (const [re, canon] of PROCESS_CANON) if (re.test(cand)) return canon;
    if (riskyProcessCategory(cand) || REMOTE_PROCESSES.test(cand) || BROWSER_PROCESSES.test(cand)) return cand;
  }
  return null;
}

/** Переводы строк и табы в печатаемом тексте: `\n` (и `\r\n`) = Enter, `\t` = Tab. */
export function textIntents(text: unknown): { newlines: number; tabs: number } {
  const s = String(text ?? "").replace(/\r\n/gu, "\n");
  return { newlines: (s.match(/[\r\n]/gu) ?? []).length, tabs: (s.match(/\t/gu) ?? []).length };
}

/** Структурная форма гранта (protocol `CommitGrant`) — shared от протокола не зависит. */
export interface GrantLike {
  signature: string;
  process: string;
  hwnd?: number;
  host?: string;
  count: number;
}

/** Грант на эту подпись в этом процессе (и окне, если грант к нему привязан) с остатком > 0; иначе null. */
export function findGrant<G extends GrantLike>(grants: readonly G[] | undefined, q: { signature: string; process: string | null; hwnd?: number }): G | null {
  if (!grants || !q.process) return null;
  return grants.find((g) => g.count > 0 && g.signature === q.signature && g.process === q.process && (g.hwnd === undefined || g.hwnd === q.hwnd)) ?? null;
}
