/**
 * W2 (пакет 0): КОНТРАКТ-ТЕСТ СТЫКА подписей. Сервер выдаёт грант по ЗАПРОСУ модели (actCommitIntent), клиент списывает
 * его по ФАКТАМ в точке инжекции (opCommitIntent: операция сайдкара + реальный элемент/фокус). Разойдись формулы —
 * «да» владельца не находится (второй вопрос) или подходит к другому действию. Строка таблицы = одно действие,
 * показанное обеим сторонам в реальной форме входа (схема инструмента на сервере, RPC-параметры сайдкара на клиенте,
 * роль ground/ground.at — «ControlType.Button», снапшота — «button»).
 */
import { describe, expect, it } from "vitest";
import { actCommitIntent, opCommitIntent, type InjectOp } from "./commit-intent.js";
import type { GuiCategory } from "./commit-risk.js";

interface Row {
  name: string;
  category: GuiCategory;
  server: { tool?: string; input: Record<string, unknown>; label?: string };
  client: Array<{ op: InjectOp; params: Record<string, unknown>; element?: { role?: string; name?: string }; focused?: { role?: string; name?: string } }>;
  /** Ожидаемые подписи; `clientDiffers` — осознанное расхождение (грант сервера действие клиента НЕ покрывает). */
  want: string[];
  clientWant?: string[];
}

const ROWS: Row[] = [
  {
    name: "act{type, enter:true} ↔ type + Enter в поле",
    category: "messenger",
    server: { input: { do: "type", target: "Сообщение", text: "привет", enter: true } },
    client: [
      { op: "click", params: { handle: 5, button: "left", count: 1 }, element: { role: "ControlType.Edit", name: "Сообщение" } },
      { op: "type", params: { text: "привет" } },
      { op: "key", params: { combo: "Enter" }, focused: { role: "Edit", name: "Сообщение" } },
    ],
    want: ["key:enter"],
  },
  {
    name: "act{do:triple} «Отправить» ↔ click count 3 по элементу",
    category: "messenger",
    server: { input: { do: "triple", target: "Отправить" } },
    client: [{ op: "click", params: { handle: 41, count: 3 }, element: { role: "ControlType.Button", name: "Отправить" } }],
    want: ["click:отправить"],
  },
  {
    name: "act{do:middle} ↔ click button middle",
    category: "messenger",
    server: { input: { do: "middle", target: "Отправить" } },
    client: [{ op: "click", params: { x: 10, y: 20, button: "middle", count: 1 }, element: { role: "ControlType.Button", name: "Отправить" } }],
    want: ["click:отправить"],
  },
  {
    name: "«Ctrl+Enter» у сервера ↔ «ctrl+enter» у клиента",
    category: "messenger",
    server: { tool: "input_key", input: { combo: "Ctrl+Enter" } },
    client: [{ op: "key", params: { combo: "ctrl+enter" }, focused: { role: "Edit", name: "Сообщение" } }],
    want: ["key:ctrl+enter"],
  },
  {
    name: "« Отправить » в запросе ↔ «отправить» у элемента",
    category: "bank",
    server: { input: { target: " « Отправить » " } },
    client: [{ op: "invoke", params: { handle: 41, pattern: "invoke" }, element: { role: "button", name: "отправить" } }],
    want: ["click:отправить"],
  },
  {
    name: "handle-метка памяти сервера — ТОЛЬКО имя (не «Отправить button»)",
    category: "messenger",
    server: { tool: "ui_invoke", input: { target: { by: "handle", handle: "41" }, pattern: "invoke" }, label: "Отправить" },
    client: [{ op: "invoke", params: { handle: 41, pattern: "invoke" }, element: { role: "button", name: "Отправить" } }],
    want: ["click:отправить"],
  },
  {
    name: "печать «a\\nb\\nc» ↔ type с двумя переводами строки",
    category: "messenger",
    server: { tool: "input_type", input: { text: "a\nb\nc" } },
    client: [{ op: "type", params: { text: "a\nb\nc" } }],
    want: ["key:enter×2"],
  },
  {
    name: "Enter на КНОПКЕ в фокусе — это клик по ней: грант key:enter его НЕ покрывает",
    category: "messenger",
    server: { input: { do: "key", combo: "Enter" } },
    client: [{ op: "key", params: { combo: "Enter" }, focused: { role: "Button", name: "Удалить чат" } }],
    want: ["key:enter"],
    clientWant: ["click:удалить чат"],
  },
];

const flat = (xs: Array<{ signature: string; count: number }>): string[] => xs.map((i) => (i.count > 1 ? `${i.signature}×${i.count}` : i.signature));

describe("контракт подписей сервер ↔ клиент", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s", (_n, r) => {
    const server = flat(actCommitIntent(r.server.input, { category: r.category, label: r.server.label, tool: r.server.tool }));
    const client = flat(
      r.client.flatMap((c) => opCommitIntent(c.op, c.params, { category: r.category, element: c.element, focused: c.focused })),
    );
    expect(server).toEqual(r.want);
    expect(client).toEqual(r.clientWant ?? r.want);
  });

  it("Space/Enter в поле ввода — печать, не коммит; Space в неизвестный фокус на клиенте — коммит, на сервере — не судится", () => {
    expect(opCommitIntent("key", { combo: "Space" }, { category: "messenger", focused: { role: "Edit" } })).toEqual([]);
    expect(flat(opCommitIntent("key", { combo: "Space" }, { category: "messenger" }))).toEqual(["key:space"]);
    expect(actCommitIntent({ do: "key", combo: "Space" }, { category: "messenger" })).toEqual([]);
    expect(opCommitIntent("key", { combo: "Enter", mode: "up" }, { category: "messenger" })).toEqual([]);
  });
});
