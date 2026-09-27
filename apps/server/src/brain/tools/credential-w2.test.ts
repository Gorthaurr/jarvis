/**
 * W2 П3 (S-5, S-6, G-3(3)(4)(5)) — §0 на сервере по ПОВЕДЕНИЮ настоящего dispatchTool: секретное поле видно по
 * голому handle из снимка («•••»), печать в фокус и вставка наследуют наведённую цель, берст «клик → печать» —
 * цепочкой. Главное: команда до ПК НЕ ДОХОДИТ, результат — честная ошибка. Легитимная печать не ломается.
 */
import { describe, expect, it } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { type ToolContext, dispatchTool } from "./dispatch.js";
import { fakeClient } from "./test-support/fake-client.js";

const SNAPSHOT = [
  { handle: 7, role: "Edit", name: "", value: "•••" }, // поле пароля: подпись немая, снимок пометил значение
  { handle: 8, role: "Edit", name: "Логин", value: "" },
  { handle: 9, role: "Button", name: "Войти" },
];

function setup(): { ctx: ToolContext; sent: ActionCommand[]; mut: () => ActionCommand[] } {
  const client = fakeClient({ snapshot: SNAPSHOT });
  const ctx = { session: { sendAction: client.sendAction }, userId: "u1", systemContext: () => "На переднем плане: chrome «Вход»" } as unknown as ToolContext;
  const mut = () => client.sent.filter((c) => c.kind !== "ui.snapshot");
  return { ctx, sent: client.sent, mut };
}

const refused = (r: { isError: boolean; content: unknown }) => {
  expect(r.isError).toBe(true);
  expect(String(r.content)).toMatch(/не ввожу, введите сами/u);
};

describe("S-5: секретный handle из снимка", () => {
  it("look{elements} (поле «•••» handle 7 числом) → ui_invoke setValue по {by:handle, handle:'7'} → отказ без отправки", async () => {
    const s = setup();
    await dispatchTool("look", { what: "elements" }, s.ctx);
    refused(await dispatchTool("ui_invoke", { target: { by: "handle", handle: "7" }, pattern: "setValue", value: "hunter2" }, s.ctx));
    expect(s.mut()).toHaveLength(0);
  });

  it("act set по handle секретного поля → отказ; по handle «Логин» — уходит", async () => {
    const s = setup();
    await dispatchTool("look", { what: "elements" }, s.ctx);
    refused(await dispatchTool("act", { do: "set", target: { handle: "7" }, text: "hunter2" }, s.ctx));
    expect(s.mut()).toHaveLength(0);
    const ok = await dispatchTool("act", { do: "set", target: { handle: "8" }, text: "owner" }, s.ctx);
    expect(ok.isError).toBe(false);
    expect(s.mut().map((c) => c.kind)).toEqual(["gui.act"]);
  });
});

describe("S-6: печать в фокус и вставка наследуют наведённую цель", () => {
  it("act «Пароль» (клик) → input_type → отказ; клик в поле по handle «•••» → input_type → отказ", async () => {
    const s = setup();
    await dispatchTool("act", { target: "Пароль" }, s.ctx);
    refused(await dispatchTool("input_type", { text: "hunter2" }, s.ctx));
    expect(s.mut().map((c) => c.kind)).toEqual(["gui.act"]); // ушёл только клик
    await dispatchTool("look", { what: "elements" }, s.ctx);
    await dispatchTool("input_click", { target: { by: "handle", handle: "7" } }, s.ctx);
    refused(await dispatchTool("input_type", { text: "hunter2" }, s.ctx));
    expect(s.mut().map((c) => c.kind)).toEqual(["gui.act", "input.click"]);
  });

  it("system_clipboard write → клик «Пароль» → Ctrl+V / Shift+Insert / act key Ctrl+Shift+V → отказ, вставка не ушла", async () => {
    const s = setup();
    await dispatchTool("system_clipboard", { op: "write", text: "hunter2" }, s.ctx);
    await dispatchTool("input_click", { target: { by: "role", role: "Edit", name: "Пароль" } }, s.ctx);
    refused(await dispatchTool("input_key", { combo: "Ctrl+V" }, s.ctx));
    refused(await dispatchTool("input_key", { combo: "Shift+Insert" }, s.ctx));
    refused(await dispatchTool("act", { do: "key", combo: "Ctrl+Shift+V" }, s.ctx));
    expect(s.mut().map((c) => c.kind)).toEqual(["system.clipboard", "input.click"]);
  });

  it("фокус ушёл (Tab) или другое окно — наследования нет: печать в следующее поле проходит", async () => {
    const s = setup();
    await dispatchTool("act", { target: "Пароль" }, s.ctx);
    await dispatchTool("input_key", { combo: "Tab" }, s.ctx);
    expect((await dispatchTool("input_type", { text: "комментарий" }, s.ctx)).isError).toBe(false);
    await dispatchTool("act", { target: "Пароль" }, s.ctx);
    await dispatchTool("app_focus", { app: "notepad" }, s.ctx);
    expect((await dispatchTool("input_type", { text: "заметка" }, s.ctx)).isError).toBe(false);
    await dispatchTool("act", { target: "Поиск" }, s.ctx);
    expect((await dispatchTool("input_type", { text: "погода" }, s.ctx)).isError).toBe(false);
  });
});

describe("G-3(4): цепочка «клик → печать» в input_batch", () => {
  it("[click role Пароль, type] → отказ, берст не ушёл; [click по handle «•••», type] — тоже", async () => {
    const s = setup();
    refused(
      await dispatchTool(
        "input_batch",
        { steps: [{ action: "input.click", target: { by: "role", role: "Edit", name: "Пароль" } }, { action: "input.type", params: { text: "hunter2" } }] },
        s.ctx,
      ),
    );
    await dispatchTool("look", { what: "elements" }, s.ctx);
    refused(
      await dispatchTool(
        "input_batch",
        { steps: [{ action: "input.click", target: { by: "handle", handle: "7" } }, { action: "input.type", params: { text: "hunter2" } }] },
        s.ctx,
      ),
    );
    expect(s.mut()).toHaveLength(0);
  });

  it("[click Пароль, app.focus Блокнот, type] — окно сменилось, цепочка рвётся: берст уходит", async () => {
    const s = setup();
    const r = await dispatchTool(
      "input_batch",
      {
        steps: [
          { action: "input.click", target: { by: "role", role: "Edit", name: "Пароль" } },
          { action: "app.focus", params: { app: "Блокнот" } },
          { action: "input.type", params: { text: "заметка" } },
        ],
      },
      s.ctx,
    );
    expect(r.isError).toBe(false);
    expect(s.mut().map((c) => c.kind)).toEqual(["skill.execute"]);
  });

  it("шаги берста — по allowlist: модельный space в цели и служебные поля params клиенту не уходят", async () => {
    const s = setup();
    await dispatchTool(
      "input_batch",
      {
        steps: [
          { action: "input.click", target: { by: "coords", x: 5, y: 6, space: "screen" }, params: { method: "physical", approval: { grants: [] }, space: "screen" } },
          { action: "input.mouse", params: { op: "move", x: 1, y: 2, space: "screen", commitApproved: true } },
        ],
      },
      s.ctx,
    );
    const cmd = s.mut()[0] as ActionCommand & { steps: unknown[] };
    expect(cmd.steps).toEqual([
      { action: "input.click", target: { by: "coords", x: 5, y: 6 }, params: { method: "physical" }, retries: 0 },
      { action: "input.mouse", params: { op: "move", x: 1, y: 2 }, retries: 0 },
    ]);
  });
});
