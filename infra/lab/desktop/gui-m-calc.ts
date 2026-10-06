import { GRID, type Op } from "./gui-calc-buttons.js";
/**
 * Калькулятор (стандартный, как в Windows 10): кнопки нажимаются и клавишами, результат — в `window.text` (значение
 * дисплея, десятичная запятая). Имена кнопок — русские, как у UIA настоящего приложения; на экране (OCR) — «5», «+», «=».
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { Ctx, Model, NodeSpec } from "./gui-model.js";
import { at, parseCombo } from "./gui-model.js";
import { ActionError } from "./gui-state.js";

export function calcModel(_ctx: Ctx, w: DesktopWindow): Model {
  let entry = "0";
  let acc: number | null = null;
  let op: Op | null = null;
  let fresh = true;
  let err = "";
  let last: { op: Op; b: number } | null = null;

  const num = (): number => Number.parseFloat(entry.replace(",", "."));
  const fmt = (n: number): string => String(+n.toPrecision(15)).replace(".", ",");
  const show = (): void => {
    w.text = err || entry;
  };
  const fail = (m: string): void => {
    err = m;
    acc = null;
    op = null;
    fresh = true;
  };
  const calc = (a: number, o: Op, b: number): number | null => {
    if (o === "/" && b === 0) return (fail(a === 0 ? "Результат не определён" : "Деление на ноль невозможно"), null);
    return o === "+" ? a + b : o === "-" ? a - b : o === "*" ? a * b : a / b;
  };
  const reset = (): void => {
    entry = "0";
    acc = null;
    op = null;
    fresh = true;
    err = "";
    last = null;
  };
  const digit = (ch: string): void => {
    if (err) reset();
    if (fresh) {
      entry = ch;
      fresh = false;
    } else if (entry.replace(/[-,]/gu, "").length < 16) entry = entry === "0" ? ch : entry + ch;
  };
  const operator = (o: Op): void => {
    if (err) return;
    if (acc !== null && op && !fresh) {
      const r = calc(acc, op, num());
      if (r === null) return;
      acc = r;
      entry = fmt(r);
    } else acc = num();
    op = o;
    fresh = true;
    last = null;
  };
  const equals = (): void => {
    if (err) return;
    const opx = op ?? last?.op;
    if (!opx) return void (fresh = true);
    const b = op ? num() : last!.b;
    const a = op ? acc! : num();
    const r = calc(a, opx, b);
    if (r === null) return;
    entry = fmt(r);
    last = { op: opx, b };
    acc = null;
    op = null;
    fresh = true;
  };
  const unary = (f: (x: number) => number | string): void => {
    if (err) return;
    const r = f(num());
    if (typeof r === "string") return fail(r);
    entry = fmt(r);
    fresh = true;
  };
  const press = (id: string): void => {
    if (/^\d$/u.test(id)) digit(id);
    else if (id === "dec") {
      if (err) reset();
      if (fresh) {
        entry = "0,";
        fresh = false;
      } else if (!entry.includes(",")) entry += ",";
    } else if (id === "+" || id === "-" || id === "*" || id === "/") operator(id);
    else if (id === "eq") equals();
    else if (id === "c") reset();
    else if (id === "ce") {
      if (err) reset();
      else {
        entry = "0";
        fresh = true;
      }
    }
    else if (id === "back") {
      if (err) reset();
      else if (!fresh) entry = entry.length > 1 && entry !== "-0" ? entry.slice(0, -1) || "0" : "0";
    } else if (id === "neg") entry = entry === "0" || err ? entry : entry.startsWith("-") ? entry.slice(1) : `-${entry}`;
    else if (id === "pct") unary((x) => (acc !== null && op ? (acc * x) / 100 : 0));
    else if (id === "sqrt") unary((x) => (x < 0 ? "Недопустимый ввод" : Math.sqrt(x)));
    else if (id === "sq") unary((x) => x * x);
    else if (id === "inv") unary((x) => (x === 0 ? "Деление на ноль невозможно" : 1 / x));
    show();
  };
  const KEYCHAR: Record<string, string> = { ".": "dec", ",": "dec", "+": "+", "-": "-", "*": "*", "×": "*", "/": "/", "÷": "/", "=": "eq", "\n": "eq", "%": "pct", "@": "sqrt", "r": "inv" };
  const charId = (ch: string): string | null => (/^\d$/u.test(ch) ? ch : (KEYCHAR[ch] ?? null));

  const m: Model = {
    kind: "calc",
    nodes(): NodeSpec[] {
      const out: NodeSpec[] = [{ id: "display", role: "text", name: `Отображается значение ${err || entry}`, automationId: "CalculatorResults", value: err || entry, label: err || entry, ...at(w, 0, 20, w.rect.w, 90), interactive: false }];
      const bw = w.rect.w / 4;
      const bh = (w.rect.h - 32 - 120) / 6;
      GRID.forEach((row, r) => row.forEach((b, c) => out.push({ id: `btn:${b.id}`, role: "button", name: b.name, label: b.label, automationId: b.aid, ...at(w, c * bw, 120 + r * bh, bw, bh), interactive: true })));
      return out;
    },
    focusId: () => null,
    press(id) {
      if (id.startsWith("btn:")) press(id.slice(4));
    },
    setValue() {
      throw new ActionError("ValuePattern не поддержан этим элементом", "runtime");
    },
    type(text) {
      for (const ch of text) {
        const id = charId(ch);
        if (id) press(id);
      }
      return true;
    },
    key(combo) {
      const k = parseCombo(combo);
      if (k.ctrl || k.alt || k.win) return false;
      const named: Record<string, string> = { enter: "eq", backspace: "back", escape: "c", delete: "ce", f9: "neg", add: "+", subtract: "-", multiply: "*", divide: "/", decimal: "dec" };
      const id = named[k.key] ?? (k.key.startsWith("numpad") ? charId(k.key.slice(6)) : k.key.length === 1 ? charId(k.key) : null);
      if (!id) return false;
      press(id);
      return true;
    },
    focus() {},
    selectedText: () => "",
  };
  show();
  return m;
}
