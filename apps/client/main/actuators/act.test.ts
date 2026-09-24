/**
 * W4 «Руки»: примитив act — лестница поиска, действие, сверка. Тесты идут через РЕАЛЬНЫЙ act() (act-find/act-do/
 * act-verify), мокаются только листья (сайдкар-грундинг, ввод, OCR, наблюдение, окна).
 *
 * Что охраняется (каждый кейс — реверт-проверяемый):
 *  - неоднозначная цель → ошибка со списком, НИЧЕГО не нажато («выбрать первый» = клик не туда с ok);
 *  - повтор только если ничего не ушло: invoke бросил ДО действия → один физический клик; verify провалился → НЕТ
 *    второго клика (дубль отправки);
 *  - «не смог проверить» ≠ «не наступило» (unknown → unchecked, не failed);
 *  - окно app не найдено → ошибка ДО поиска и действия;
 *  - бюджет: ступень, на которую времени нет, не начинается — честная ошибка.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({
  items: [] as Array<{ handle: number; role: string; name: string; automationId?: string; value?: string; x: number; y: number; w: number; h: number }>,
  truncated: false,
  snapshotCalls: 0,
  ocr: { text: "", lines: [] as Array<{ text: string; x: number; y: number; w: number; h: number }>, mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } as { boundsX: number; boundsY: number; scale: number } | undefined },
  ocrCalls: 0,
  groundAt: async (_x: number, _y: number): Promise<{ handle: string; bbox?: { x: number; y: number; w: number; h: number } }> => ({ handle: "77", bbox: { x: 0, y: 0, w: 80, h: 30 } }),
  invoke: vi.fn(async (_t: unknown, _p: string, _v?: string): Promise<void> => undefined),
  click: vi.fn(async (_t: unknown, _m?: string, _r?: boolean, _o?: unknown): Promise<{ screenX: number; screenY: number } | undefined> => undefined),
  typeText: vi.fn(async (_t: string): Promise<void> => undefined),
  pressKey: vi.fn(async (_c: string): Promise<void> => undefined),
  pasteText: vi.fn(async (_t: string): Promise<void> => undefined),
  wait: async (_timeoutMs?: number): Promise<{ met: boolean; elapsedMs: number; polls: number; detail: string; unknown?: boolean }> => ({ met: true, elapsedMs: 120, polls: 1, detail: "видно «Отправлено»" }),
  waitCalls: [] as unknown[],
  observation: { via: "a11y", text: "+ появилось «Отправлено»", delta: true, changed: true } as unknown,
  focusWindow: async (_o: unknown): Promise<{ focused: boolean; hwnd: number; title: string }> => ({ focused: true, hwnd: 1, title: "Telegram" }),
  focusApp: async (_a: string): Promise<{ resolved: string; focused: boolean }> => ({ resolved: "x", focused: false }),
  fg: null as string | null, // процесс на переднем плане для §14-рубежа act (контроль-2 №4)
}));

vi.mock("./ground.js", () => ({
  uiSnapshot: async () => {
    st.snapshotCalls += 1;
    return { window: "W", pid: 1, items: st.items, truncated: st.truncated };
  },
  groundAtPoint: (x: number, y: number) => st.groundAt(x, y),
  invoke: (t: unknown, p: string, v?: string) => st.invoke(t, p, v),
}));
vi.mock("./screen.js", () => ({ getLastCaptureMapping: () => ({ boundsX: 0, boundsY: 0, scale: 1 }) }));
vi.mock("./sensors-cheap.js", () => ({
  screenOcr: async () => {
    st.ocrCalls += 1;
    return { ...st.ocr, width: 100, height: 100 };
  },
  waitFor: async (cond: unknown, timeoutMs: number) => {
    st.waitCalls.push({ cond, timeoutMs });
    return st.wait(timeoutMs);
  },
}));
vi.mock("./input.js", () => ({
  click: (t: unknown, m?: string, r?: boolean, o?: unknown) => st.click(t, m, r, o),
  typeText: (t: string) => st.typeText(t),
  pressKey: (c: string) => st.pressKey(c),
}));
vi.mock("./paste-text.js", () => ({ PASTE_FROM_CHARS: 80, pasteText: (t: string) => st.pasteText(t) }));
vi.mock("./observe.js", () => ({
  captureUiFingerprint: async () => ({ lines: ["Button: Отправить"] }),
  observeAfterAction: async () => st.observation,
}));
vi.mock("./windows.js", () => ({
  focusWindow: (o: unknown) => st.focusWindow(o),
  listWindows: async () => (st.fg ? [{ foreground: true, process: st.fg }] : []),
}));
vi.mock("./apps.js", () => ({ focusApp: (a: string) => st.focusApp(a) }));

import { act } from "./act.js";
import { ActFindError, findTarget, scoreItem } from "./act-find.js";
import { ActPartialError } from "./act-do.js";
import { verifyCondition } from "./act-verify.js";

const btn = (handle: number, name: string, role = "Button", extra: Partial<(typeof st.items)[number]> = {}) => ({ handle, role, name, x: 0, y: 0, w: 10, h: 10, ...extra });
const OPTS = { restoreCursor: true };

beforeEach(() => {
  st.items = [btn(11, "Отправить"), btn(12, "Отправить всем"), btn(13, "Поиск", "Edit")];
  st.truncated = false;
  st.snapshotCalls = 0;
  st.ocr = { text: "", lines: [], mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } };
  st.ocrCalls = 0;
  st.groundAt = async () => ({ handle: "77", bbox: { x: 0, y: 0, w: 80, h: 30 } });
  st.invoke.mockReset();
  st.click.mockReset();
  st.typeText.mockReset();
  st.pressKey.mockReset();
  // Предпроверка (500 мс, до действия) — признака ещё нет; сверка после действия — признак наступил.
  st.wait = async (timeoutMs?: number) =>
    (timeoutMs ?? 0) <= 500 ? { met: false, elapsedMs: 500, polls: 1, detail: "ещё нет" } : { met: true, elapsedMs: 120, polls: 1, detail: "видно «Отправлено»" };
  st.waitCalls = [];
  st.observation = { via: "a11y", text: "+ появилось «Отправлено»", delta: true, changed: true };
  st.focusWindow = async () => ({ focused: true, hwnd: 1, title: "Telegram" });
  st.focusApp = async () => ({ resolved: "x", focused: false });
});

describe("act — поиск по снапшоту UIA", () => {
  it("точное имя побеждает подстроку: «Отправить» → invoke по handle 11, verify met → verified:met", async () => {
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Отправлено" } }, OPTS);
    expect(st.invoke).toHaveBeenCalledTimes(1);
    expect(st.invoke.mock.calls[0]?.[0]).toEqual({ by: "handle", handle: "11" });
    expect(r.found).toMatchObject({ via: "snapshot", name: "Отправить", role: "Button", handle: "11" });
    expect(r.verified).toBe("met");
    expect(st.click).not.toHaveBeenCalled();
    expect(st.waitCalls).toContainEqual(expect.objectContaining({ cond: expect.objectContaining({ kind: "text", text: "Отправлено", gone: false }), timeoutMs: 4000 }));
  });

  it("две РАВНЫЕ кнопки «Отправить» → ошибка с кандидатами, ничего не нажато", async () => {
    st.items = [btn(11, "Отправить"), btn(21, "Отправить")];
    const p = act({ kind: "gui.act", target: "Отправить" }, OPTS);
    await expect(p).rejects.toBeInstanceOf(ActFindError);
    await expect(p).rejects.toThrow(/неоднозначна.*Button «Отправить»/su);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click).not.toHaveBeenCalled();
  });

  it("роль сужает поиск: target {text:'Поиск', role:'Edit'} → handle 13; чужая роль не матчится", async () => {
    const r = await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "set", text: "кот" }, OPTS);
    expect(st.invoke).toHaveBeenCalledWith({ by: "handle", handle: "13" }, "setValue", "кот");
    expect(r.did).toMatch(/установил значение/u);
    await expect(act({ kind: "gui.act", target: { text: "Поиск", role: "Button" } }, OPTS)).rejects.toThrow(/не найдена/u);
  });

  it("не найдено → ошибка перечисляет ВИДИМЫЕ элементы и пометку об усечённом снапшоте", async () => {
    st.truncated = true;
    const p = act({ kind: "gui.act", target: "Скачать" }, OPTS);
    await expect(p).rejects.toThrow(/не найдена.*усечён.*Button «Отправить»/su);
    expect(st.ocrCalls).toBe(1); // OCR пробовали, тоже пусто
    expect(st.invoke).not.toHaveBeenCalled();
  });
});

describe("act — ступень OCR и точка", () => {
  it("в снапшоте нет → OCR-строка → центр в экранных DIP (mapping) → ground.at → бесшумный invoke", async () => {
    st.items = [];
    st.ocr = { text: "Играть", lines: [{ text: "Играть", x: 100, y: 50, w: 40, h: 20 }], mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } };
    let at: { x: number; y: number } | null = null;
    st.groundAt = async (x, y) => {
      at = { x, y };
      return { handle: "77", bbox: { x: 0, y: 0, w: 80, h: 30 } };
    };
    const r = await act({ kind: "gui.act", target: "Играть" }, OPTS);
    expect(at).toEqual({ x: 240, y: 120 });
    expect(st.invoke).toHaveBeenCalledWith({ by: "handle", handle: "77" }, "invoke", undefined);
    expect(r.found).toMatchObject({ via: "ocr", handle: "77" });
    expect(r.verified).toBe("unchecked"); // verify не задан
  });

  it("OCR нашёл, под точкой UIA пусто → физический клик по координатам space:screen", async () => {
    st.items = [];
    st.ocr = { text: "Играть", lines: [{ text: "Играть", x: 100, y: 50, w: 40, h: 20 }], mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } };
    st.groundAt = async () => {
      throw new Error("нет элемента");
    };
    st.click.mockResolvedValue({ screenX: 240, screenY: 120 });
    const r = await act({ kind: "gui.act", target: "Играть" }, OPTS);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click).toHaveBeenCalledWith({ by: "coords", x: 240, y: 120, space: "screen" }, "physical", true, {});
    expect(r).toMatchObject({ screenX: 240, screenY: 120, physical: true });
    expect(r.found?.note).toMatch(/физическим кликом/u);
  });

  it("OCR без маппинга (нет кадра) → честная ошибка, а не клик мимо", async () => {
    st.items = [];
    st.ocr = { text: "Играть", lines: [{ text: "Играть", x: 1, y: 1, w: 1, h: 1 }], mapping: undefined };
    await expect(act({ kind: "gui.act", target: "Играть" }, OPTS)).rejects.toThrow(/без маппинга/u);
    expect(st.click).not.toHaveBeenCalled();
  });

  it("цель-точка x/y: элемент под точкой → invoke по его handle; снапшот не читается", async () => {
    await act({ kind: "gui.act", target: { x: 10, y: 20 } }, OPTS);
    expect(st.snapshotCalls).toBe(0);
    expect(st.invoke).toHaveBeenCalledWith({ by: "handle", handle: "77" }, "invoke", undefined);
  });
});

describe("act — повтор только если ничего не ушло", () => {
  it("invoke бросил ДО действия → ОДИН физический клик по тому же handle; verify провалился → verified:failed без второго клика", async () => {
    st.invoke.mockRejectedValueOnce(new Error("InvokePattern не поддержан"));
    st.wait = async () => ({ met: false, elapsedMs: 4000, polls: 5, detail: "текста нет" });
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Отправлено" } }, OPTS);
    expect(st.invoke).toHaveBeenCalledTimes(1);
    expect(st.click).toHaveBeenCalledTimes(1);
    expect(st.click.mock.calls[0]?.[0]).toEqual({ by: "handle", handle: "11" });
    expect(r.verified).toBe("failed");
    expect(r.did).toMatch(/физический клик.*не поддержан/u);
  });

  it("сенсор не смог проверить (unknown) → verified:unchecked, не failed", async () => {
    st.wait = async () => ({ met: false, unknown: true, elapsedMs: 1, polls: 0, detail: "сайдкар не ответил" });
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Отправлено" } }, OPTS);
    expect(r.verified).toBe("unchecked");
    expect(r.detail).toMatch(/не смог проверить/u);
  });

  it("do:type — клик в поле ушёл, печать упала → ActPartialError (исход неизвестен), без повтора клика", async () => {
    st.typeText.mockRejectedValueOnce(new Error("сайдкар лёг"));
    const p = act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: "кот" }, OPTS);
    await expect(p).rejects.toBeInstanceOf(ActPartialError);
    expect(st.click).toHaveBeenCalledTimes(1);
  });
});

describe("act — окно app, глаголы, бюджет", () => {
  it("app не найдено (сайдкар и AppActivate не сфокусировали) → ошибка ДО поиска и действия", async () => {
    st.focusWindow = async () => ({ focused: false, hwnd: 0, title: "" });
    await expect(act({ kind: "gui.act", app: "Telegram", target: "Отправить" }, OPTS)).rejects.toThrow(/окно «Telegram» не найдено.*ничего не нажато/u);
    expect(st.snapshotCalls).toBe(0);
    expect(st.invoke).not.toHaveBeenCalled();
  });

  it("app сфокусировано → ответ несёт focused; do:key → pressKey без цели; do:key без combo → ошибка", async () => {
    const r = await act({ kind: "gui.act", app: "Telegram", do: "key", combo: "Ctrl+S" }, OPTS);
    expect(r.focused).toBe("Telegram");
    expect(st.pressKey).toHaveBeenCalledWith("Ctrl+S");
    await expect(act({ kind: "gui.act", do: "key" }, OPTS)).rejects.toThrow(/без combo/u);
  });

  it("do:type → сначала клик (silent по handle), затем печать; do:right → физический правый клик", async () => {
    await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: "кот" }, OPTS);
    expect(st.click).toHaveBeenCalledWith({ by: "handle", handle: "13" }, "silent", true, undefined);
    expect(st.typeText).toHaveBeenCalledWith("кот");
    st.click.mockClear();
    await act({ kind: "gui.act", target: "Отправить", do: "right" }, OPTS);
    expect(st.click).toHaveBeenCalledWith({ by: "handle", handle: "11" }, "physical", true, { button: "right" });
  });

  it("бюджет: дедлайн истёк → снапшот не начинается; после снапшота на OCR времени нет → ошибка без OCR", async () => {
    await expect(findTarget("Скачать", Date.now() - 1)).rejects.toThrow(/Бюджет act исчерпан/u);
    expect(st.snapshotCalls).toBe(0);
    await expect(findTarget("Скачать", Date.now() + 5_000)).rejects.toThrow(/на OCR времени не осталось/u);
    expect(st.snapshotCalls).toBe(1);
    expect(st.ocrCalls).toBe(0);
  });
});

describe("чистые функции", () => {
  it("scoreItem: automationId точный > точное имя > префикс > подстрока > value; роль-фильтр", () => {
    const it0 = btn(1, "Отправить всем", "Button", { automationId: "SendAll", value: "" });
    expect(scoreItem(it0, { automationId: "sendall" })).toBe(40);
    expect(scoreItem(it0, { automationId: "other" })).toBe(0);
    expect(scoreItem(btn(1, "Отправить"), { text: "отправить" })).toBe(30);
    expect(scoreItem(it0, { text: "Отправить" })).toBe(20);
    expect(scoreItem(btn(1, "Не отправить"), { text: "отправить" })).toBe(10);
    expect(scoreItem(btn(1, "", "Edit", { value: "отправить письмо" }), { text: "отправить" })).toBe(5);
    expect(scoreItem(btn(1, "Отправить"), { text: "Отправить", role: "Edit" })).toBe(0);
    expect(scoreItem(btn(1, "Любая"), { role: "Button" })).toBe(1);
  });

  it("verifyCondition: text → wait text; element → ui substring; title → window; gone пробрасывается; пусто → null", () => {
    expect(verifyCondition({ text: " Отправлено " })).toEqual({ kind: "text", text: "Отправлено", monitor: "active", gone: false });
    expect(verifyCondition({ element: { role: "Window", name: "Сохранить" }, gone: true })).toEqual({ kind: "ui", role: "Window", name: "Сохранить", nameMode: "substring", gone: true });
    expect(verifyCondition({ title: "Блокнот" })).toEqual({ kind: "window", titleContains: "Блокнот", gone: false });
    expect(verifyCondition({ timeoutMs: 3000 })).toBeNull();
  });
});


/** Ревью 2026-09-24: дефекты act, найденные до первого живого прогона (H-A1, H-A2, H-T1, H-T2, H-V1). */
describe("act — фиксы ревью 2026-09-24", () => {
  it("H-A1: под точкой крупный контейнер → физический клик В ТОЧКУ, не invoke по handle и не центр контейнера", async () => {
    st.groundAt = async () => ({ handle: "99", bbox: { x: 0, y: 0, w: 1343, h: 756 } });
    st.click.mockResolvedValue({ screenX: 500, screenY: 400 });
    const r = await act({ kind: "gui.act", target: { x: 500, y: 400, space: "screen" } }, OPTS);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click.mock.calls[0]?.[0]).toEqual({ by: "coords", x: 500, y: 400, space: "screen" });
    expect(r.found?.note ?? "").toMatch(/контейнер/);
  });

  it("H-A1: invoke по handle не поддержан → физический фолбэк кликает в найденную ТОЧКУ, а не в центр элемента", async () => {
    st.invoke.mockRejectedValueOnce(new Error("не поддерживает InvokePattern"));
    st.click.mockResolvedValue({ screenX: 500, screenY: 400 });
    await act({ kind: "gui.act", target: { x: 500, y: 400, space: "screen" } }, OPTS);
    expect(st.click).toHaveBeenCalledTimes(1);
    expect(st.click.mock.calls[0]?.[0]).toEqual({ by: "coords", x: 500, y: 400, space: "screen" });
  });

  it("H-A2: на переднем плане окно самого Джарвиса (pid = наш) → честный отказ, ничего не нажато", async () => {
    const realPid = process.pid;
    Object.defineProperty(process, "pid", { value: 1, configurable: true }); // мок снапшота отдаёт pid 1
    try {
      await expect(act({ kind: "gui.act", target: "Отправить" }, OPTS)).rejects.toThrow(/окно самого Джарвиса/);
      expect(st.invoke).not.toHaveBeenCalled();
      expect(st.click).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "pid", { value: realPid, configurable: true });
    }
  });

  it("H-T2: invoke упал по ТАЙМАУТУ → исход неизвестен (ActPartialError), второго физического клика нет", async () => {
    st.invoke.mockRejectedValueOnce(new Error("sidecar timeout op=invoke"));
    await expect(act({ kind: "gui.act", target: "Отправить" }, OPTS)).rejects.toBeInstanceOf(ActPartialError);
    expect(st.click).not.toHaveBeenCalled();
  });

  it("H-T1: длинный текст вставляется (paste), а не печатается посимвольно", async () => {
    const long = "а".repeat(300);
    st.click.mockResolvedValue({ screenX: 1, screenY: 1 });
    await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "type", text: long }, OPTS);
    expect(st.pasteText).toHaveBeenCalledWith(long);
    expect(st.typeText).not.toHaveBeenCalled();
  });

  it("do:type БЕЗ цели → печать в поле с фокусом: ни поиска, ни клика; без text — ошибка; прочие глаголы без цели — ошибка", async () => {
    const r = await act({ kind: "gui.act", app: "Discord", do: "type", text: "general" }, OPTS);
    expect(st.snapshotCalls).toBe(0);
    expect(st.click).not.toHaveBeenCalled();
    expect(st.typeText).toHaveBeenCalledWith("general");
    expect(r.did).toMatch(/в поле с фокусом/u);
    await expect(act({ kind: "gui.act", do: "type" }, OPTS)).rejects.toThrow(/без text/u);
    await expect(act({ kind: "gui.act", do: "click" }, OPTS)).rejects.toThrow(/без target/u);
  });

  it("do:type без цели: печать упала посреди → ActPartialError (часть могла уйти), не молчаливый провал", async () => {
    st.typeText.mockRejectedValueOnce(new Error("сайдкар лёг"));
    await expect(act({ kind: "gui.act", do: "type", text: "привет" }, OPTS)).rejects.toBeInstanceOf(ActPartialError);
  });

  // Контроль-2 №4: проводка рубежа в самом act. Реверт: убери вызов assertActCommitAllowed в act.ts — Enter нажмётся.
  it("app «tele» сфокусировал Telegram, Enter без подтверждения сервера → отказ ДО нажатия; с подтверждением — нажимает", async () => {
    st.fg = "Telegram";
    try {
      await expect(act({ kind: "gui.act", app: "tele", do: "key", combo: "Enter" }, OPTS)).rejects.toThrow(/§14.*Ничего не нажато/u);
      expect(st.pressKey).not.toHaveBeenCalled();
      await act({ kind: "gui.act", app: "Telegram", do: "key", combo: "Enter", commitApproved: true }, OPTS);
      expect(st.pressKey).toHaveBeenCalledWith("Enter");
    } finally {
      st.fg = null;
    }
  });

  it("H-V1: признак был виден ещё ДО действия → итог unchecked, а не «подтверждено»", async () => {
    st.wait = async () => ({ met: true, elapsedMs: 50, polls: 1, detail: "видно «Настройки»" });
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Настройки" } }, OPTS);
    expect(r.verified).toBe("unchecked");
    expect(r.detail).toMatch(/ДО действия/);
  });
});
