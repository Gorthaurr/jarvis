/**
 * ПРОВОДКА гарда учётных данных (§0 принцип 5) — по ПОВЕДЕНИЮ диспетчера, а не по грепу исходника.
 *
 * Проверяется главное: команда до актуатора/расширения НЕ ДОХОДИТ (пароль не напечатан), результат
 * — честная ОШИБКА (иначе петля взвела бы `anyMutateSucceeded` и ход закончился бы «Готово, сэр» на
 * невведённом пароле), и легитимная печать по тем же путям продолжает работать.
 *
 * Путей ввода семь: input_type, browser_act{type}, browser_batch, web_act{type}, ui_invoke{setValue},
 * system_clipboard{write} и те же действия внутри input_batch — каждый со своим кейсом.
 */
import { describe, expect, it } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { rememberUiHandles } from "./commit-gate.js";
import { type ToolContext, dispatchTool } from "./dispatch.js";

interface Spy {
  ctx: ToolContext;
  actions: ActionCommand[];
  ext: string[];
}

/** Контекст с расширением: фиксируем ВСЁ, что реально ушло к компьютеру владельца. */
function spyCtx(): Spy {
  const actions: ActionCommand[] = [];
  const ext: string[] = [];
  const ctx = {
    userId: "u1",
    session: {
      sendAction: async (cmd: ActionCommand) => {
        actions.push(cmd);
        return { commandId: "c1", ok: true, durationMs: 1 };
      },
    },
    ext: {
      connected: true,
      openOrFocus: async () => ({ tabId: 7 }),
      tabInspect: async () => ({
        url: "https://site.test/login",
        gen: 3,
        elements: [
          { idx: 0, ref: "e3_0", role: "input", name: "Логин", selector: "#login" },
          { idx: 1, ref: "e3_1", role: "input", name: "Пароль", selector: "#pass" },
        ],
      }),
      tabAct: async () => {
        ext.push("act");
        return {};
      },
      tabBatch: async () => {
        ext.push("batch");
        return { ok: true, done: 2, total: 2 };
      },
      tabRead: async () => ({}),
      tabList: async () => ({ tabs: [] }),
      tabClose: async () => ({ closed: 0 }),
      exportCookies: async () => ({ cookies: [] }),
    },
  } as unknown as ToolContext;
  return { ctx, actions, ext };
}

const TAB = { url: "https://site.test/login" };

describe("пароли и коды подтверждения: ввод не доходит до компьютера", () => {
  it("input_type с номером карты → ошибка, ActionCommand НЕ отправлен", async () => {
    const s = spyCtx();
    const r = await dispatchTool("input_type", { text: "4111 1111 1111 1111" }, s.ctx);
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
    expect(String(r.content)).toMatch(/платёжные реквизиты/i);
  });

  it("system_clipboard write с номером карты → ошибка, буфер не тронут", async () => {
    const s = spyCtx();
    const r = await dispatchTool("system_clipboard", { op: "write", text: "4111111111111111" }, s.ctx);
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
  });

  it("ui_invoke setValue в поле «Пароль» → ошибка, UIA-команда не ушла", async () => {
    const s = spyCtx();
    const r = await dispatchTool(
      "ui_invoke",
      { target: { by: "role", role: "Edit", name: "Пароль" }, pattern: "setValue", value: "s3cret" },
      s.ctx,
    );
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
    expect(String(r.content)).toMatch(/не ввожу, введите сами/i);
  });

  // Ревью 2026-09-24: act — главный путь печати с W4, в гарде его не было.
  it("act do:type в поле «Пароль» (цель строкой) → ошибка, gui.act не ушёл", async () => {
    const s = spyCtx();
    const r = await dispatchTool("act", { do: "type", target: "Пароль", text: "s3cret" }, s.ctx);
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
    expect(String(r.content)).toMatch(/не ввожу, введите сами/i);
  });

  it("act do:set с номером карты → ошибка, gui.act не ушёл", async () => {
    const s = spyCtx();
    const r = await dispatchTool("act", { do: "set", target: { role: "Edit" }, text: "4111 1111 1111 1111" }, s.ctx);
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
  });

  it("act do:type по handle поля пароля из последнего снимка → ошибка", async () => {
    const s = spyCtx();
    rememberUiHandles(s.ctx.session as unknown as object, { items: [{ handle: 42, name: "Пароль", role: "Edit" }] });
    const r = await dispatchTool("act", { do: "type", target: { handle: "42" }, text: "s3cret" }, s.ctx);
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
  });

  // Контроль-2 №2: слот навыка и печать в фокус после клика по полю пароля. Реверт: убери case skill_execute /
  // наследование цели в dispatchTool — соответствующий тест упадёт.
  it("skill_execute со слотом password → ошибка, реплей не ушёл (а без пароля — уходит)", async () => {
    const s = spyCtx();
    // Навык реально исполнимый: без гарда шаг «{{password}}» ушёл бы клиенту skill.execute (иначе тест декоративен).
    const skill = (slot: string) => ({ id: "login", version: 1, steps: [{ action: "input.type", params: { text: `{{${slot}}}` } }] });
    let current = skill("query");
    (s.ctx as unknown as { skills: unknown }).skills = { get: async () => current };
    await dispatchTool("skill_execute", { skillId: "login", params: { query: "погода" } }, s.ctx);
    expect(s.actions.map((a) => a.kind)).toEqual(["skill.execute"]); // контроль: обычный слот исполняется
    s.actions.length = 0;
    current = skill("password");
    const r = await dispatchTool("skill_execute", { skillId: "login", params: { password: "фиктивное-значение" } }, s.ctx); // не секрет: гард режет по ИМЕНИ слота
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
  });

  it("act{target:«Пароль»} (клик) → act{do:type} без цели → ошибка: поле унаследовано из прошлого act", async () => {
    const s = spyCtx();
    await dispatchTool("act", { target: "Пароль" }, s.ctx);
    const r = await dispatchTool("act", { do: "type", text: "s3cret" }, s.ctx);
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(1); // только клик
  });

  it("browser_act type в input[type=password] → ошибка, расширение не вызвано", async () => {
    const s = spyCtx();
    const r = await dispatchTool(
      "browser_act",
      { ...TAB, intent: "type", params: { selector: 'input[type="password"]', text: "s3cret" } },
      s.ctx,
    );
    expect(r.isError).toBe(true);
    expect(s.ext).toHaveLength(0);
  });

  it("web_act type в поле кода из СМС → ошибка, невидимый браузер не тронут", async () => {
    const s = spyCtx();
    const r = await dispatchTool("web_act", { intent: "type", params: { selector: "#sms-code", text: "481502" } }, s.ctx);
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
  });

  it("browser_batch: шаг в поле пароля (по ref из снимка) → весь берст отклонён", async () => {
    const s = spyCtx();
    await dispatchTool("browser_inspect", TAB, s.ctx); // снимок знает подписи полей
    const r = await dispatchTool(
      "browser_batch",
      {
        ...TAB,
        steps: [
          { ref: "e3_0", intent: "type", params: { text: "anton" } },
          { ref: "e3_1", intent: "type", params: { text: "s3cret" } },
        ],
      },
      s.ctx,
    );
    expect(r.isError).toBe(true);
    expect(s.ext).not.toContain("batch"); // ни один шаг не исполнен — логин заполняет владелец
  });

  it("input_batch: шаг input.type с номером карты → берст не отправлен", async () => {
    const s = spyCtx();
    const r = await dispatchTool(
      "input_batch",
      { steps: [{ action: "input.type", params: { text: "4111 1111 1111 1111" } }] },
      s.ctx,
    );
    expect(r.isError).toBe(true);
    expect(s.actions).toHaveLength(0);
  });
});

describe("🔴 легитимная работа по тем же путям не сломана", () => {
  it("input_type обычного текста с числами доходит до клиента без нотаций", async () => {
    const s = spyCtx();
    const r = await dispatchTool("input_type", { text: "Счёт на 15000 рублей за январь 2026" }, s.ctx);
    expect(r.isError).toBe(false);
    expect(s.actions).toHaveLength(1);
    expect(String(r.content)).not.toMatch(/введите сами/i);
  });

  it("act do:type в поле «Поиск» доходит до клиента", async () => {
    const s = spyCtx();
    const r = await dispatchTool("act", { do: "type", target: "Поиск", text: "погода в Москве" }, s.ctx);
    expect(r.isError).toBe(false);
    expect(s.actions.map((a) => a.kind)).toEqual(["gui.act"]);
  });

  it("browser_act type в обычное поле поиска исполняется", async () => {
    const s = spyCtx();
    const r = await dispatchTool("browser_act", { ...TAB, intent: "type", params: { selector: "#search", text: "погода" } }, s.ctx);
    expect(r.isError).toBe(false);
    expect(s.ext).toContain("act");
  });

  it("browser_batch без полей-секретов исполняется целиком", async () => {
    const s = spyCtx();
    await dispatchTool("browser_inspect", TAB, s.ctx);
    const r = await dispatchTool(
      "browser_batch",
      { ...TAB, steps: [{ ref: "e3_0", intent: "type", params: { text: "anton" } }, { ref: "e3_0", intent: "enter" }] },
      s.ctx,
    );
    expect(r.isError).toBe(false);
    expect(s.ext).toContain("batch");
  });

  it("голый код без признака поля печатается, но модель получает предупреждение (не отказ)", async () => {
    const s = spyCtx();
    const r = await dispatchTool("input_type", { text: "481502" }, s.ctx);
    expect(r.isError).toBe(false);
    expect(s.actions).toHaveLength(1); // работу не ломаем
    expect(String(r.content)).toMatch(/не ввожу, введите сами/i);
  });
});
