/** gui.act (лестница UIA→OCR→точка, met/failed/unchecked, injected) и UIA-команды ui.ground/snapshot/invoke, context.read. */
import { describe, expect, it } from "vitest";
import { grant, kit } from "./gui-testkit.js";

describe("gui.act: исходы сверки", () => {
  it("met: клик по «Пять» с verify.text — признак наступил, UIA invoke без физики", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const r = await k.ok({ kind: "gui.act", app: "Калькулятор", target: "Пять", verify: { element: { role: "text", name: "значение 5" } } });
    expect(r).toMatchObject({ verified: "met", physical: false, focused: "Калькулятор" });
    expect(r.found).toMatchObject({ via: "snapshot", name: "Пять" });
    expect(r.did).toContain("UIA invoke");
    expect(k.win("CalculatorApp").text).toBe("5");
  });

  it("failed: действие ушло, признак не наступил — не «не сделано» (эффект есть), детали называют ожидание", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const t0 = k.d.snapshot().effects.length;
    const r = await k.ok({ kind: "gui.act", target: "Пять", verify: { text: "ЭтогоНетНаЭкране" } });
    expect(r.verified).toBe("failed");
    expect(r.detail).toContain("НЕ наступил");
    expect(k.win("CalculatorApp").text).toBe("5"); // действие реально произошло
    expect(k.d.snapshot().effects.length).toBeGreaterThan(t0);
  });

  it("unchecked: без verify исход честно не подтверждён; дельта наблюдения приложена", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const r = await k.ok({ kind: "gui.act", target: "Семь" });
    expect(r.verified).toBe("unchecked");
    expect(r.observation.changed).toBe(true);
    expect(r.detail).toContain("verify не задан");
  });

  it("признак, видимый ещё ДО действия, не засчитывается как доказательство", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const r = await k.ok({ kind: "gui.act", target: "Семь", verify: { title: "Калькулятор" } });
    expect(r.verified).toBe("unchecked");
    expect(r.detail).toContain("ДО действия");
  });

  it("gone:true — исчезновение диалога после нажатия «Отмена»", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.type", text: "x" });
    await k.ok({ kind: "input.key", combo: "Ctrl+S" });
    const r = await k.ok({ kind: "gui.act", app: "Сохранение", target: "Отмена", verify: { title: "Сохранение", gone: true } });
    expect(r.verified).toBe("met");
    expect(k.d.snapshot().windows.some((w) => w.title === "Сохранение")).toBe(false);
  });

  it("verify без признака — исход не сверен (unchecked), не «met»", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const r = await k.ok({ kind: "gui.act", target: "Семь", verify: {} });
    expect(r.verified).toBe("unchecked");
  });
});

describe("gui.act: поиск цели без догадок", () => {
  it("цель не найдена — runtime с перечнем видимого, ничего не нажато", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const t0 = k.d.snapshot().effects.length;
    const e = await k.fail({ kind: "gui.act", target: "Гиперболический косинус" });
    expect(e.code).toBe("runtime");
    expect(e.message).toContain("не найдена");
    expect(e.injected).toBe(false);
    expect(k.d.snapshot().effects.length).toBe(t0);
  });

  it("неоднозначная цель — ошибка со списком, а не первый попавшийся", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    // Роль без имени подходит десятку кнопок с равным весом → отказ, а не «первая попавшаяся»:
    const amb = await k.fail({ kind: "gui.act", target: { role: "button" } });
    expect(amb.message).toContain("неоднозначна");
  });

  it("окно app не найдено — ошибка ДО любого действия", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const e = await k.fail({ kind: "gui.act", app: "Photoshop", target: "Пять" });
    expect(e.message).toContain("не найдено");
    expect(k.win("CalculatorApp").text).toBe("0");
  });

  it("OCR-ступень: цель без UIA-имени находится по видимому тексту кнопки (label)", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "input.type", text: "9" });
    const r = await k.ok({ kind: "gui.act", target: "√" });
    expect(r.found.via).toBe("ocr");
    expect(r.found.note).toContain("OCR");
    expect(r.physical).toBe(true); // кнопка выше порога «мелкого» (60 px) — клик точкой, не UIA invoke
    expect(k.win("CalculatorApp").text).toBe("3");
    expect(k.effects("input.click")[0]!.detail.node).toBe("Квадратный корень");
  });

  it("цель координатами в кадре: без кадра — not_found; с кадром из screen.capture — попадает в кнопку", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    expect((await k.fail({ kind: "gui.act", target: { x: 5, y: 5 } })).code).toBe("not_found");
    const cap = await k.ok({ kind: "screen.capture", monitor: 0, scale: 1 });
    const b = (await k.ok({ kind: "ui.ground", query: { role: "button", name: "Восемь" } })).bbox;
    const px = (b.x + b.w / 2) * (cap.width / 2560);
    const py = (b.y + b.h / 2) * (cap.height / 1440);
    const r = await k.ok({ kind: "gui.act", target: { x: Math.round(px), y: Math.round(py), frame: cap.frameId } });
    expect(k.win("CalculatorApp").text).toBe("8");
    expect(r.found.via).toBe("point");
  });

  it("валидация: type без text, scroll без dy, clear без type — ошибки до действия", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    for (const cmd of [{ do: "type" }, { do: "scroll", target: "Файл" }, { do: "click", target: "Файл", clear: true }, { do: "drag", target: "Файл" }]) {
      expect((await k.fail({ kind: "gui.act", ...cmd })).code).toBe("runtime");
    }
    expect(k.effects("input.type")).toHaveLength(0);
  });
});

describe("gui.act: ввод, вуаль, рубеж", () => {
  it("do:type в поле — клик + печать; clear заменяет содержимое", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "gui.act", do: "type", target: { role: "edit" }, text: "первый" });
    await k.ok({ kind: "gui.act", do: "type", target: { role: "edit" }, text: "второй", clear: true });
    expect(k.win("notepad").text).toBe("второй");
  });

  it("do:set — ValuePattern без физики; на калькуляторе (нет паттерна) — честная ошибка", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    const r = await k.ok({ kind: "gui.act", do: "set", target: { role: "edit" }, text: "готово" });
    expect(r.physical).toBe(false);
    expect(k.win("notepad").text).toBe("готово");
    await k.ok({ kind: "app.launch", app: "calc" });
    expect((await k.fail({ kind: "gui.act", do: "set", target: "Пять", text: "1" })).code).toBe("runtime");
  });

  it("Enter в act ловится ДО клика: отказ, ничего не ушло — injected НЕ выставляется (повтор безопасен)", async () => {
    const k = kit({ windows: [{ process: "Telegram", title: "Катя — Telegram" }] });
    const e = await k.fail({ kind: "gui.act", do: "type", target: { role: "edit", automationId: "MessageInput" }, text: "привет", enter: true });
    expect(e.code).toBe("denied");
    expect(e.injected).toBe(false);
    expect(k.effects("input.click")).toHaveLength(0);
    expect(k.effects("app.message.sent")).toHaveLength(0);
  });

  it("часть действия ушла (клик в поле прошёл, длинная вставка с переводом строки отказана §14) — stepActionInjected", async () => {
    const k = kit({ windows: [{ process: "Telegram", title: "Катя — Telegram" }] });
    const long = `${"а".repeat(90)}
вторая строка`; // ≥80 символов = вставка: ранняя проверка не срабатывает
    const e = await k.fail({ kind: "gui.act", do: "type", target: { role: "edit", automationId: "MessageInput" }, text: long });
    expect(e.code).toBe("denied");
    expect(e.injected).toBe(true);
    expect(k.effects("input.click")).toHaveLength(1);
    expect(k.effects("app.message.sent")).toHaveLength(0);
  });

  it("с грантом на Enter act{type, enter} отправляет сообщение один раз", async () => {
    const k = kit({ windows: [{ process: "Telegram", title: "Катя — Telegram" }] });
    const denied = await k.fail({ kind: "gui.act", do: "key", combo: "Enter" });
    const sig = denied.data.needsApproval.signature as string;
    const r = await k.ok({ kind: "gui.act", do: "type", target: { role: "edit", automationId: "MessageInput" }, text: "привет", enter: true, ...grant(sig, "telegram") });
    expect(r.physical).toBe(true);
    expect(k.effects("app.message.sent").map((e) => e.detail.text)).toEqual(["привет"]);
  });

  it("клик по «Отправить» без гранта: denied, ничего не отправлено и не нажато физически", async () => {
    const k = kit({ windows: [{ process: "Telegram", title: "Катя — Telegram" }] });
    await k.ok({ kind: "input.type", text: "секрет" });
    const e = await k.fail({ kind: "gui.act", target: "Отправить" });
    expect(e.code).toBe("denied");
    expect(k.effects("app.message.sent")).toHaveLength(0);
    expect(k.effects("input.click")).toHaveLength(0);
  });

  it("вуаль выделения: физические глаголы → overlay_drawing (не провал модели)", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "screen.selection", op: "start" });
    const e = await k.fail({ kind: "gui.act", target: "Пять", physical: true });
    expect(e.code).toBe("overlay_drawing");
    expect(k.win("CalculatorApp").text).toBe("0");
  });
});

describe("ui.ground / ui.snapshot / ui.invoke / context.read", () => {
  it("ui.ground: handle СТРОКОЙ, bbox, role ControlType.*; несуществующий — runtime", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const g = await k.ok({ kind: "ui.ground", query: { role: "button", name: "Плюс" } });
    expect(typeof g.handle).toBe("string");
    expect(g.role).toBe("ControlType.Button");
    expect(g.bbox.w).toBeGreaterThan(0);
    expect((await k.ok({ kind: "ui.ground", query: { role: "button", automationId: "equalButton" } })).name).toBe("Равно");
    expect((await k.ok({ kind: "ui.ground", query: { role: "button", name: "плю", nameMode: "substring" } })).name).toBe("Плюс");
    expect((await k.fail({ kind: "ui.ground", query: { role: "button", name: "Нет" } })).message).toContain("не найден");
  });

  it("ui.snapshot: handle ЧИСЛОМ, короткая роль, только интерактивные, усечение maxItems, пустой без окна", async () => {
    const k = kit();
    expect(await k.ok({ kind: "ui.snapshot" })).toMatchObject({ items: [], truncated: false });
    await k.ok({ kind: "app.launch", app: "calc" });
    const s = await k.ok({ kind: "ui.snapshot" });
    expect(s.window).toBe("Калькулятор");
    expect(typeof s.items[0].handle).toBe("number");
    expect(s.items.every((i: any) => i.role === "button")).toBe(true);
    const cut = await k.ok({ kind: "ui.snapshot", maxItems: 5 });
    expect(cut.items).toHaveLength(5);
    expect(cut.truncated).toBe(true);
    expect((await k.fail({ kind: "ui.snapshot", frame: "labf999" })).code).toBe("not_found");
  });

  it("ui.snapshot с кадром отдаёт bbox в пикселях картинки", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const cap = await k.ok({ kind: "screen.capture", monitor: 0, scale: 0.5 });
    const s = await k.ok({ kind: "ui.snapshot", frame: cap.frameId });
    const g = await k.ok({ kind: "ui.ground", query: { role: "button", name: "Один" } });
    const item = s.items.find((i: any) => i.name === "Один");
    expect(item.x).toBe(Math.round(g.bbox.x * (cap.width / 2560)));
    expect(s.frame).toBe(cap.frameId);
  });

  it("ui.invoke: invoke меняет состояние, setValue пишет поле, пустой value и coords отклонены, не-интерактивный — не поддержан", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const h = Number((await k.ok({ kind: "ui.ground", query: { role: "button", name: "Три" } })).handle);
    await k.ok({ kind: "ui.invoke", target: { by: "handle", handle: h }, pattern: "invoke" });
    expect(k.win("CalculatorApp").text).toBe("3");
    const disp = Number((await k.ok({ kind: "ui.ground", query: { role: "text" } })).handle);
    expect((await k.fail({ kind: "ui.invoke", target: { by: "handle", handle: disp }, pattern: "invoke" })).message).toContain("не поддержан");
    expect((await k.fail({ kind: "ui.invoke", target: { by: "handle", handle: h }, pattern: "setValue", value: "" })).code).toBe("runtime");
    expect((await k.fail({ kind: "ui.invoke", target: { by: "coords", x: 1, y: 1, space: "screen" }, pattern: "invoke" })).code).toBe("runtime");
    await k.ok({ kind: "app.launch", app: "notepad" });
    const edit = Number((await k.ok({ kind: "ui.ground", query: { role: "edit" } })).handle);
    await k.ok({ kind: "ui.invoke", target: { by: "handle", handle: edit }, pattern: "setValue", value: "через UIA" });
    expect(k.win("notepad").text).toBe("через UIA");
  });

  it("ui.invoke §14: invoke кнопки «Отправить» в мессенджере без гранта — denied", async () => {
    const k = kit({ windows: [{ process: "Telegram", title: "Катя — Telegram" }] });
    const h = Number((await k.ok({ kind: "ui.ground", query: { role: "button", name: "Отправить" } })).handle);
    const e = await k.fail({ kind: "ui.invoke", target: { by: "handle", handle: h }, pattern: "invoke" });
    expect(e.code).toBe("denied");
  });

  it("context.read: active_window — выжимка UIA, selection — выделенный текст (после Ctrl+A), без окна — пусто", async () => {
    const k = kit();
    expect(await k.ok({ kind: "context.read", scope: "active_window" })).toEqual({ scope: "active_window", text: "" });
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.type", text: "выдели меня" });
    expect((await k.ok({ kind: "context.read", scope: "selection" })).text).toBe("");
    await k.ok({ kind: "input.key", combo: "Ctrl+A" });
    expect((await k.ok({ kind: "context.read", scope: "selection" })).text).toBe("выдели меня");
    expect((await k.ok({ kind: "context.read", scope: "active_window" })).text).toContain("выдели меня");
  });
});
