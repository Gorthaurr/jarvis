/**
 * Стенд: плейсхолдеры во входах инструментов — одна реализация для /dev/bench/tool и сценарного LLM (/dev/bench/say).
 *   "$ref:<подпись>"  → ref элемента из ПОСЛЕДНЕГО снимка browser_inspect (name|text|label|aria; ё→е, без регистра;
 *                       сначала точное совпадение подписи, потом вхождение).
 *   "$match:<regex>"  → первая группа (или всё совпадение) в тексте последнего результата инструмента.
 * Неразрешённый плейсхолдер остаётся литералом и попадает в `unresolved` — вызывающий решает, звать ли инструмент.
 */
import type { LlmMessage } from "../../integrations/llm.js";

const DOM_MARK = '<untrusted_content source="DOM вкладки';

export function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

/** Элементы снимка из текста результата browser_inspect (JSON внутри untrusted-обёртки). */
export function inspectElements(text: string): Array<Record<string, unknown>> {
  const at = text.lastIndexOf(DOM_MARK);
  if (at < 0) return [];
  const start = text.indexOf("\n", at) + 1;
  const end = text.indexOf("\n</untrusted_content>", start);
  if (start <= 0 || end < 0) return [];
  try {
    const j = JSON.parse(text.slice(start, end)) as { elements?: unknown };
    return Array.isArray(j.elements) ? (j.elements as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

export function isInspectText(text: string): boolean {
  return text.includes(DOM_MARK);
}

/** ref по подписи: точное совпадение одного из полей подписи, иначе вхождение. */
export function findRef(elements: Array<Record<string, unknown>>, label: string): string | undefined {
  const want = norm(label);
  if (!want) return undefined;
  const labels = (e: Record<string, unknown>): string[] => ["name", "text", "label", "aria"].map((k) => norm(e[k])).filter(Boolean);
  const withRef = elements.filter((e) => typeof e.ref === "string" && e.ref);
  const exact = withRef.find((e) => labels(e).includes(want));
  const loose = exact ?? withRef.find((e) => labels(e).some((l) => l.includes(want)));
  return loose ? String(loose.ref) : undefined;
}

/** Тексты tool_result из истории петли (хронологически). */
export function toolResultTexts(messages: LlmMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      out.push(typeof b.content === "string" ? b.content : b.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n"));
    }
  }
  return out;
}

export interface Resolution {
  value: Record<string, unknown>;
  resolved: Record<string, string>;
  unresolved: string[];
}

/** Подставить плейсхолдеры во входе инструмента (глубоко: объекты/массивы). */
export function resolvePlaceholders(input: Record<string, unknown>, inspectText: string, lastText: string): Resolution {
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  const elements = inspectElements(inspectText);
  const one = (s: string): string => {
    if (s.startsWith("$ref:")) {
      const ref = findRef(elements, s.slice(5));
      if (ref) return (resolved[s] = ref);
    } else if (s.startsWith("$match:")) {
      let m: RegExpMatchArray | null = null;
      try {
        m = lastText.match(new RegExp(s.slice(7), "u"));
      } catch {
        m = null;
      }
      const v = m ? (m[1] ?? m[0]) : undefined;
      if (v !== undefined) return (resolved[s] = v);
    } else {
      return s;
    }
    unresolved.push(s);
    return s;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return one(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(input) as Record<string, unknown>, resolved, unresolved };
}
