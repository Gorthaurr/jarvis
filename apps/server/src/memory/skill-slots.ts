/**
 * Слоты навыка — параметризация replay-навыка переменными `{{name}}` (§8).
 *
 * Идея (разговор 2026-06-23): навык на ПК = последовательность шагов С ПЕРЕМЕННЫМИ. Сильная
 * модель (Opus) авторит шаблон один раз, при повторе дешёвая модель / детерминированный резолвер
 * лишь ЗАПОЛНЯЕТ переменные, а исполнение детерминированно ($0 LLM). Здесь — чистый слой
 * подстановки: `extractSlots` (какие переменные нужны навыку) + `fillSlots` (подставить значения,
 * ЧЕСТНО сообщив о незаполненных). Закон честности: незаполненный слот НЕЛЬЗЯ слать в актуатор
 * литералом `{{contact}}` — caller обязан не исполнять навык, пока `missing` непуст.
 *
 * Шаблонируются ТОЛЬКО строковые поля шага: target.role/name/handle, строковые params-значения,
 * expect.role/name/state/text. `action` (фиксированный глагол) и числовые координаты x/y НЕ трогаем.
 * Не-строковые params сохраняются как есть. Литеральный навык (без `{{...}}`) проходит без изменений.
 */
import type { SkillStep, Target } from "@jarvis/protocol";

/** `{{name}}` — имя слота: буква/подчёркивание, далее слово-символы/дефис. Пробелы внутри скобок ок. */
const SLOT_RE = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;

/** Собрать имена слотов, на которые ссылается строка, в аккумулятор. */
function collectSlots(s: string, out: Set<string>): void {
  for (const m of s.matchAll(SLOT_RE)) out.add(m[1]!);
}

/** Все уникальные слоты, нужные навыку (для авторства/валидации/подсказки модели). */
export function extractSlots(steps: readonly SkillStep[]): string[] {
  const out = new Set<string>();
  for (const step of steps) {
    const t = step.target;
    if (t?.by === "role") {
      collectSlots(t.role, out);
      if (t.name) collectSlots(t.name, out);
    } else if (t?.by === "handle") {
      collectSlots(t.handle, out);
    }
    for (const v of Object.values(step.params ?? {})) if (typeof v === "string") collectSlots(v, out);
    const e = step.expect;
    if (e) for (const v of [e.role, e.name, e.state, e.text]) if (typeof v === "string") collectSlots(v, out);
  }
  return [...out];
}

/**
 * Подставить значение слота в строку. Слот без значения (нет ключа / null / пустая строка) →
 * добавляется в `missing` и плейсхолдер ОСТАЁТСЯ (caller не должен исполнять при непустом missing).
 */
function fillString(s: string, vars: Record<string, unknown>, missing: Set<string>): string {
  return s.replace(SLOT_RE, (full, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      missing.add(name);
      return full;
    }
    return String(v);
  });
}

/** Подставить слоты в target (строковые поля; координаты — без шаблона). Иммутабельно. */
function fillTarget(t: Target, vars: Record<string, unknown>, missing: Set<string>): Target {
  if (t.by === "role") {
    return { ...t, role: fillString(t.role, vars, missing), ...(t.name ? { name: fillString(t.name, vars, missing) } : {}) };
  }
  if (t.by === "handle") return { ...t, handle: fillString(t.handle, vars, missing) };
  return t;
}

/**
 * Заполнить слоты во всех шагах из карты переменных. Возвращает НОВЫЕ шаги (исходные не мутируются)
 * и список незаполненных слотов. Пустой `missing` ⇒ навык готов к детерминированному исполнению.
 */
export function fillSlots(
  steps: readonly SkillStep[],
  vars: Record<string, unknown>,
): { steps: SkillStep[]; missing: string[] } {
  const missing = new Set<string>();
  const filled = steps.map((step): SkillStep => {
    const next: SkillStep = { ...step };
    if (step.target) next.target = fillTarget(step.target, vars, missing);
    if (step.params) {
      const p: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(step.params)) p[k] = typeof v === "string" ? fillString(v, vars, missing) : v;
      next.params = p;
    }
    if (step.expect) {
      const e = { ...step.expect };
      if (typeof e.role === "string") e.role = fillString(e.role, vars, missing);
      if (typeof e.name === "string") e.name = fillString(e.name, vars, missing);
      if (typeof e.state === "string") e.state = fillString(e.state, vars, missing);
      if (typeof e.text === "string") e.text = fillString(e.text, vars, missing);
      next.expect = e;
    }
    return next;
  });
  return { steps: filled, missing: [...missing] };
}
