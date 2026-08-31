// Волна F (адаптация OpenClaw, F1): нормализованная сигнатура повторов anti-runaway.
import { describe, expect, it } from "vitest";
import { repeatSignature } from "./repeat-key.js";

describe("repeatSignature (F1)", () => {
  it("перестановка ключей объекта НЕ делает вызов «новым»", () => {
    const a = repeatSignature([{ name: "app_launch", input: { app: "x", args: "-a" } }]);
    const b = repeatSignature([{ name: "app_launch", input: { args: "-a", app: "x" } }]);
    expect(a).toBe(b);
  });

  it("косметические пробелы в строках схлопываются (trim + прогоны)", () => {
    const a = repeatSignature([{ name: "web_search", input: { query: "погода  завтра " } }]);
    const b = repeatSignature([{ name: "web_search", input: { query: "погода завтра" } }]);
    expect(a).toBe(b);
  });

  it("волатильные поля (nonce/idempotency_key/request_id) не участвуют в сигнатуре", () => {
    const a = repeatSignature([{ name: "telegram_send", input: { to: "Катя", text: "привет", nonce: "111" } }]);
    const b = repeatSignature([{ name: "telegram_send", input: { to: "Катя", text: "привет", nonce: "222" } }]);
    const c = repeatSignature([{ name: "telegram_send", input: { to: "Катя", text: "привет", idempotency_key: "k1", requestId: "r9" } }]);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("волатильные поля вычищаются и во ВЛОЖЕННЫХ объектах (у ВСТРОЕННЫХ инструментов)", () => {
    const a = repeatSignature([{ name: "telegram_send", input: { params: { traceId: "t1", q: "a" } } }]);
    const b = repeatSignature([{ name: "telegram_send", input: { params: { traceId: "t2", q: "a" } } }]);
    expect(a).toBe(b);
  });

  // 🔴 Контроль волны F: ложный «повтор» → ложный ЧЕСТНЫЙ ПРОВАЛ легитимной работы.
  it("КОНТЕНТНЫЕ поля не нормализуются по пробелам: разные отступы/переносы = разные действия", () => {
    const py1 = repeatSignature([{ name: "code_run", input: { lang: "python", code: "def f():\n    return 1" } }]);
    const py2 = repeatSignature([{ name: "code_run", input: { lang: "python", code: "def f():\n  return 1" } }]);
    expect(py1).not.toBe(py2); // отступ в Python — семантика

    const w1 = repeatSignature([{ name: "fs_write", input: { path: "a.yaml", content: "a:\n  b: 1" } }]);
    const w2 = repeatSignature([{ name: "fs_write", input: { path: "a.yaml", content: "a:\n    b: 1" } }]);
    expect(w1).not.toBe(w2);

    const t1 = repeatSignature([{ name: "input_type", input: { text: "строка один\nстрока два" } }]);
    const t2 = repeatSignature([{ name: "input_type", input: { text: "строка один строка два" } }]);
    expect(t1).not.toBe(t2);

    const e1 = repeatSignature([{ name: "fs_edit", input: { old_string: "x  y", new_string: "z" } }]);
    const e2 = repeatSignature([{ name: "fs_edit", input: { old_string: "x y", new_string: "z" } }]);
    expect(e1).not.toBe(e2);
  });

  it("НЕ контентные строки по-прежнему нормализуются (косметика вызова)", () => {
    const a = repeatSignature([{ name: "app_launch", input: { app: " dota  2 " } }]);
    const b = repeatSignature([{ name: "app_launch", input: { app: "dota 2" } }]);
    expect(a).toBe(b);
  });

  it("у mcp__* волатильные ИМЕНА не выбрасываются (могут быть селектором цели)", () => {
    const a = repeatSignature([{ name: "mcp__sentry__get_trace", input: { trace_id: "aaa" } }]);
    const b = repeatSignature([{ name: "mcp__sentry__get_trace", input: { trace_id: "bbb" } }]);
    expect(a).not.toBe(b); // перебор РАЗНЫХ трейсов ≠ топтание на месте
  });

  it("если выброс волатильных опустошает input — поле было селектором, сигнатуры различаются", () => {
    const a = repeatSignature([{ name: "some_tool", input: { request_id: "42" } }]);
    const b = repeatSignature([{ name: "some_tool", input: { request_id: "43" } }]);
    expect(a).not.toBe(b);
  });

  it("СЕМАНТИЧЕСКИ разный ввод остаётся разным (честность: не глушим легитимную серию)", () => {
    const a = repeatSignature([{ name: "app_launch", input: { app: "x" } }]);
    const b = repeatSignature([{ name: "app_launch", input: { app: "y" } }]);
    expect(a).not.toBe(b);
    // Таймстамп-ЗНАЧЕНИЯ не нормализуются: два напоминания на разное время — два разных дела.
    const r1 = repeatSignature([{ name: "set_reminder", input: { text: "таблетки", fireAt: 1700000000000 } }]);
    const r2 = repeatSignature([{ name: "set_reminder", input: { text: "таблетки", fireAt: 1700000360000 } }]);
    expect(r1).not.toBe(r2);
  });

  it("порядок элементов МАССИВА — семантика, не нормализуется", () => {
    const a = repeatSignature([{ name: "input_batch", input: { steps: ["a", "b"] } }]);
    const b = repeatSignature([{ name: "input_batch", input: { steps: ["b", "a"] } }]);
    expect(a).not.toBe(b);
  });

  it("имя инструмента и состав раунда входят в сигнатуру", () => {
    const one = repeatSignature([{ name: "a", input: {} }]);
    const other = repeatSignature([{ name: "b", input: {} }]);
    const two = repeatSignature([{ name: "a", input: {} }, { name: "b", input: {} }]);
    expect(one).not.toBe(other);
    expect(one).not.toBe(two);
  });

  it("скалярный/пустой input не роняет и различается", () => {
    expect(repeatSignature([{ name: "a", input: undefined }])).toBeTypeOf("string");
    expect(repeatSignature([{ name: "a", input: null }])).toBeTypeOf("string");
    expect(repeatSignature([{ name: "a", input: "s" }])).not.toBe(repeatSignature([{ name: "a", input: "t" }]));
  });
});
