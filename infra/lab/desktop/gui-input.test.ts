/** Ввод FakeDesktop: клавиатура, мышь, приложения (блокнот/калькулятор/мессенджер), вуаль, USER_BUSY, рубеж §14. */
import { describe, expect, it } from "vitest";
import { grant, kit } from "./gui-testkit.js";

const press = async (k: ReturnType<typeof kit>, name: string): Promise<void> => {
  await k.ok({ kind: "input.click", target: { by: "role", role: "button", name } });
};

describe("честность ввода", () => {
  it("ввод без окна в фокусе — ошибка, а не ok", async () => {
    const k = kit();
    const e = await k.fail({ kind: "input.type", text: "привет" });
    expect(e.code).toBe("runtime");
    expect(e.message).toContain("нет окна в фокусе");
    expect(k.effects("input.type")).toHaveLength(0);
    expect((await k.fail({ kind: "input.key", combo: "Enter" })).code).toBe("runtime");
  });

  it("печать в блокнот меняет window.text и заголовок (звёздочка), эффект несёт текст", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    const r = await k.ok({ kind: "input.type", text: "привет, мир" });
    expect(k.win("notepad").text).toBe("привет, мир");
    expect(k.win("notepad").title).toBe("*Безымянный — Блокнот");
    expect(k.effects("input.type")[0]!.detail).toMatchObject({ text: "привет, мир", accepted: true });
    expect(r.observation.via).toBe("a11y"); // дельта окна прикладывается, как у fused-observe
  });

  it("окно, не принимающее ввод (стим), — ok, но accepted:false в эффекте: текст никуда не попал", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "steam" });
    await k.ok({ kind: "input.type", text: "абв" });
    expect(k.effects("input.type")[0]!.detail.accepted).toBe(false);
    expect(k.win("steam").text).toBe("");
  });

  it("запрещённая комбинация (Alt+F4) отклонена, окно живо; зажатый Alt + F4 — тоже", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    expect((await k.fail({ kind: "input.key", combo: "Alt+F4" })).message).toContain("app_close");
    await k.ok({ kind: "input.key", combo: "Alt", mode: "down" });
    expect((await k.fail({ kind: "input.key", combo: "F4" })).code).toBe("runtime");
    await k.ok({ kind: "input.key", combo: "Alt", mode: "up" });
    expect(k.d.snapshot().windows).toHaveLength(1);
  });

  it("Ctrl+A, Backspace, Enter в блокноте работают; Ctrl+S без пути открывает диалог сохранения", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.type", text: "abc" });
    await k.ok({ kind: "input.key", combo: "Backspace" });
    await k.ok({ kind: "input.key", combo: "Enter" });
    expect(k.win("notepad").text).toBe("ab\n");
    await k.ok({ kind: "input.key", combo: "Ctrl+A" });
    await k.ok({ kind: "input.key", combo: "Ctrl+C" });
    expect(k.d.snapshot().clipboard).toBe("ab\n");
    await k.ok({ kind: "input.key", combo: "Ctrl+S" });
    expect(k.d.snapshot().windows.some((w) => w.title === "Сохранение")).toBe(true);
  });

  it("сохранение через диалог кладёт файл в виртуальную ФС и снимает звёздочку", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.type", text: "заметка" });
    await k.ok({ kind: "input.key", combo: "Ctrl+S" });
    await k.ok({ kind: "input.type", text: "note" });
    await press(k, "Сохранить");
    expect(k.d.snapshot().files["C:/Users/lab/Documents/note.txt"]).toBe("заметка");
    expect(k.win("notepad").title).toBe("note.txt — Блокнот");
    expect(k.effects("fs.write")[0]!.detail).toMatchObject({ path: "C:/Users/lab/Documents/note.txt", via: "notepad" });
  });

  it("открытие текстового файла из ФС показывает его содержимое в блокноте", async () => {
    const k = kit({ files: { "Documents/a.txt": "из файла" } });
    await k.ok({ kind: "app.launch", app: "C:\\Users\\lab\\Documents\\a.txt" });
    expect(k.win("notepad").text).toBe("из файла");
    expect((await k.fail({ kind: "app.launch", app: "C:\\Users\\lab\\Documents\\нет.txt" })).code).toBe("not_found");
  });
});

describe("калькулятор: клики по кнопкам меняют состояние", () => {
  it("12 + 7 = 19 нажатием кнопок по UIA (role+name)", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    for (const n of ["Один", "Два", "Плюс", "Семь", "Равно"]) await press(k, n);
    expect(k.win("CalculatorApp").text).toBe("19");
  });

  it("клавиатурой и физическим кликом в координаты кнопки — тот же результат", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "input.type", text: "6*7=" });
    expect(k.win("CalculatorApp").text).toBe("42");
    const g = await k.ok({ kind: "ui.ground", query: { role: "button", name: "Ноль" } });
    const b = g.bbox;
    await k.ok({ kind: "input.click", target: { by: "coords", x: b.x + 5, y: b.y + 5, space: "screen" }, method: "physical" });
    expect(k.win("CalculatorApp").text).toBe("0");
    expect(k.effects("input.click")).toHaveLength(1);
  });

  it("деление на ноль — сообщение об ошибке, а не Infinity", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "input.type", text: "5/0=" });
    expect(k.win("CalculatorApp").text).toBe("Деление на ноль невозможно");
  });

  it("дробные с запятой: 1,5 + 2,25 = 3,75", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "input.type", text: "1,5+2,25=" });
    expect(k.win("CalculatorApp").text).toBe("3,75");
  });
});

describe("клики и мышь", () => {
  it("клик по несуществующему элементу — ошибка, состояние не тронуто", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const e = await k.fail({ kind: "input.click", target: { by: "role", role: "button", name: "Синус" } });
    expect(e.code).toBe("runtime");
    expect(k.win("CalculatorApp").text).toBe("0");
  });

  it("клик по устаревшему handle (окно закрыто) — честная ошибка", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const h = (await k.ok({ kind: "ui.ground", query: { role: "button", name: "Пять" } })).handle;
    await k.ok({ kind: "app.close", app: "calc" });
    const e = await k.fail({ kind: "input.click", target: { by: "handle", handle: Number(h) } });
    expect(e.message).toContain("не найден");
  });

  it("координаты без кадра отклоняются (нет догадок), с space:screen — принимаются", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const e = await k.fail({ kind: "input.click", target: { by: "coords", x: 10, y: 10 } });
    expect(e.code).toBe("not_found");
    expect(e.message).toContain("screen_capture");
    await k.ok({ kind: "input.click", target: { by: "coords", x: 10, y: 10, space: "screen" } });
  });

  it("mouse down+up без сдвига — клик по кнопке; drag пишет эффект", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const b = (await k.ok({ kind: "ui.ground", query: { role: "button", name: "Девять" } })).bbox;
    const x = b.x + 3;
    const y = b.y + 3;
    await k.ok({ kind: "input.mouse", op: "down", x, y, space: "screen" });
    await k.ok({ kind: "input.mouse", op: "up", x, y, space: "screen" });
    expect(k.win("CalculatorApp").text).toBe("9");
    await k.ok({ kind: "input.mouse", op: "drag", x, y, toX: x + 50, toY: y, space: "screen" });
    expect(k.effects("input.drag")).toHaveLength(1);
    expect((await k.fail({ kind: "input.mouse", op: "drag", x, y, space: "screen" })).code).toBe("runtime");
  });

  it("USER_BUSY: проактивный физический ввод при недавнем вводе владельца отклонён denied; спустя 4 с — идёт", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    k.d.userAction("input", {});
    const e = await k.fail({ kind: "input.type", text: "x", proactive: true });
    expect(e.code).toBe("denied");
    expect(e.message).toContain("USER_BUSY");
    expect(k.win("notepad").text).toBe("");
    k.d.advance(4500);
    await k.ok({ kind: "input.type", text: "x", proactive: true });
    expect(k.win("notepad").text).toBe("x");
  });
});

describe("рубеж §14 (мессенджер)", () => {
  const seed = { windows: [{ process: "Telegram", title: "Катя — Telegram" }] };

  it("Enter/«Отправить» без гранта — denied + needsApproval, сообщение НЕ ушло", async () => {
    const k = kit(seed);
    await k.ok({ kind: "input.type", text: "привет" });
    const e = await k.fail({ kind: "input.key", combo: "Enter" });
    expect(e.code).toBe("denied");
    expect(e.data.needsApproval).toMatchObject({ category: expect.any(String), signature: expect.stringContaining("enter"), process: "telegram" });
    expect(e.data.needsApproval.pendingText).toBe("привет");
    expect(k.effects("app.message.sent")).toHaveLength(0);
    const click = await k.fail({ kind: "input.click", target: { by: "role", role: "button", name: "Отправить" } });
    expect(click.code).toBe("denied");
    expect(k.effects("app.message.sent")).toHaveLength(0);
  });

  it("с готовым грантом Enter отправляет ОДИН раз; второй Enter без гранта снова denied", async () => {
    const k = kit(seed);
    await k.ok({ kind: "input.type", text: "привет" });
    const denied = await k.fail({ kind: "input.key", combo: "Enter" });
    const sig = denied.data.needsApproval.signature as string;
    await k.ok({ kind: "input.key", combo: "Enter", ...grant(sig, "telegram") });
    expect(k.effects("app.message.sent")).toHaveLength(1);
    expect(k.effects("app.message.sent")[0]!.detail).toMatchObject({ chat: "Катя", text: "привет" });
    await k.ok({ kind: "input.type", text: "ещё" });
    expect((await k.fail({ kind: "input.key", combo: "Enter" })).code).toBe("denied");
    expect(k.effects("app.message.sent")).toHaveLength(1);
  });

  it("грант на другой процесс/просроченный не действует", async () => {
    const k = kit(seed);
    await k.ok({ kind: "input.type", text: "привет" });
    const sig = (await k.fail({ kind: "input.key", combo: "Enter" })).data.needsApproval.signature as string;
    expect((await k.fail({ kind: "input.key", combo: "Enter", ...grant(sig, "discord") })).code).toBe("denied");
    const stale = { approval: { grants: [{ signature: sig, process: "telegram", count: 1 }], expiresAt: Date.now() - 1000 } };
    expect((await k.fail({ kind: "input.key", combo: "Enter", ...stale })).code).toBe("denied");
    expect(k.effects("app.message.sent")).toHaveLength(0);
  });

  it("обычная печать в мессенджер §14 не судит (черновик, не отправка)", async () => {
    const k = kit(seed);
    await k.ok({ kind: "input.type", text: "черновик" });
    expect(k.effects("app.message.sent")).toHaveLength(0);
  });

  it("окно самого Джарвиса — отказ §0 без вопроса", async () => {
    const k = kit({ windows: [{ process: "electron", title: "Jarvis" }] });
    const e = await k.fail({ kind: "input.key", combo: "Enter" });
    expect(e.code).toBe("denied");
    expect(e.data).toBeUndefined();
  });
});
