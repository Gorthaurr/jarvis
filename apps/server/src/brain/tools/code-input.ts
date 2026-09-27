/**
 * W3 (L-2, G-14): вызов, чей КОД драйвит мышь/клавиатуру. Python-скрипт с `import jarvis` получает мост актуаторов
 * клиента (code-runner кладёт jarvis.py на PYTHONPATH и отдаёт адрес+токен моста ТОЛЬКО python) и кликает, печатает,
 * фокусит окна — те же руки, что act/input_*. Правило ОДНО для всех потребителей (аренда ввода §20, долг сверки,
 * отказ фоновому SDK): python + модуль `jarvis` в import/from/`__import__`/importlib. node/powershell моста не
 * получают — по этому правилу ввод не драйвят.
 */
import type { DynamicToolStore } from "./dynamic.js";

/** Код вызова: язык и текст, который уйдёт в code.run. */
export interface CallCode {
  lang: string;
  code: string;
}

/** Резолвер кода вызова: code_run — из входа, самописный инструмент — из реестра владельца. */
export type ResolveCode = (name: string, input: unknown) => CallCode | undefined;

// `import jarvis`, `import os, jarvis`, `import jarvis as j`, `from jarvis import click` — с начала строки (с отступом)
// или после `;`/`:` (однострочники `import os; import jarvis`, `try: import jarvis`). `jarvis_x`/`a.jarvis` — не SDK.
const IMPORT_STMT = /(?:^|[;:])[ \t]*(?:import[ \t]+[^\n;#]*(?<![\w.])jarvis(?!\w)|from[ \t]+jarvis(?!\w))/mu;
// `__import__("jarvis")`, `importlib.import_module("jarvis")`.
const DYNAMIC_IMPORT = /(?:__import__|import_module)\s*\(\s*(?:name\s*=\s*)?['"]jarvis['"]/u;

/** Драйвит ли этот код ввод через SDK jarvis (см. шапку). */
export function codeDrivesInput(lang: string, code: string): boolean {
  return lang === "python" && (IMPORT_STMT.test(code) || DYNAMIC_IMPORT.test(code));
}

/**
 * Код, который исполнит вызов. Самописный инструмент — шаблон плюс значения аргументов: подстановка идёт текстом,
 * и `import jarvis` может прийти аргументом (консервативно: лишняя сверка дешевле клика без аренды). `render()` не
 * зовём — он считает запуски, а здесь лишь классификация вызова.
 */
export function codeOfCall(name: string, input: unknown, dynamicTools?: DynamicToolStore, userId?: string): CallCode | undefined {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === "code_run") return { lang: String(i.lang ?? ""), code: String(i.code ?? "") };
  if (!dynamicTools || userId === undefined || !dynamicTools.has(userId, name)) return undefined;
  const tool = dynamicTools.list(userId).find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tool) return undefined;
  return { lang: tool.lang, code: [tool.code, ...Object.values(i).map((v) => String(v ?? ""))].join("\n") };
}

/** Резолвер с реестром самописных инструментов владельца (петля берёт его из deps задачи). */
export const codeResolver =
  (dynamicTools?: DynamicToolStore, userId?: string): ResolveCode =>
  (name, input) =>
    codeOfCall(name, input, dynamicTools, userId);

/** Драйвит ли ВЫЗОВ ввод кодом. Без резолвера распознаётся только code_run (самописные — через реестр). */
export function callDrivesInput(name: string, input: unknown, resolveCode?: ResolveCode): boolean {
  const src = resolveCode ? resolveCode(name, input) : codeOfCall(name, input);
  return src !== undefined && codeDrivesInput(src.lang, src.code);
}
