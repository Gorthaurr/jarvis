import { describe, expect, it, vi } from "vitest";
import { BlankPageError, type BrowserReader, compareBrowserValue, evalBrowserCondition, isBrowserCondition } from "./browser-condition.js";

describe("compareBrowserValue — сравнение DOM-значения с условием (чистая)", () => {
  it("числовые операторы (currentTime ≥/≤/>/<)", () => {
    expect(compareBrowserValue(1600, ">=", 1560)).toBe(true);
    expect(compareBrowserValue(1500, ">=", 1560)).toBe(false);
    expect(compareBrowserValue(1500, "<=", 1560)).toBe(true);
    expect(compareBrowserValue(1600, ">", 1600)).toBe(false);
    expect(compareBrowserValue(1601, ">", 1600)).toBe(true);
    expect(compareBrowserValue(1599, "<", 1600)).toBe(true);
  });

  it("дефолтный оператор для чисел = >= (частый кейс «видео дошло до N»)", () => {
    expect(compareBrowserValue(1560, undefined, 1560)).toBe(true);
    expect(compareBrowserValue(1559, undefined, 1560)).toBe(false);
  });

  it("строковое значение из DOM коэрсится к числу для числового оператора", () => {
    expect(compareBrowserValue("1600", ">=", 1560)).toBe(true);
  });

  it("== / != / contains — строковое сравнение (в т.ч. paused:boolean)", () => {
    expect(compareBrowserValue(false, "==", false)).toBe(true);
    expect(compareBrowserValue(true, "==", false)).toBe(false);
    expect(compareBrowserValue(true, "!=", false)).toBe(true);
    expect(compareBrowserValue("Идёт трансляция", "contains", "трансляц")).toBe(true);
    expect(compareBrowserValue("Пауза", "contains", "трансляц")).toBe(false);
  });

  it("null/undefined/нечисло для числового оператора → false (честное «нет»)", () => {
    expect(compareBrowserValue(undefined, ">=", 1560)).toBe(false);
    expect(compareBrowserValue(null, ">=", 1560)).toBe(false);
    expect(compareBrowserValue("не число", ">=", 1560)).toBe(false);
  });
});

describe("isBrowserCondition", () => {
  it("узнаёт browser-условие и отвергает прочие", () => {
    expect(isBrowserCondition({ kind: "browser", value: 1560 })).toBe(true);
    expect(isBrowserCondition({ kind: "text", text: "26:0" })).toBe(false);
    expect(isBrowserCondition(null)).toBe(false);
    expect(isBrowserCondition("browser")).toBe(false);
  });
});

/** Мок ext-моста: readMedia отдаёт состояние видео, getValue — произвольное свойство. */
function mockExt(over: Partial<BrowserReader> = {}, media = { currentTime: 1600, duration: 3600, paused: false }): BrowserReader {
  return {
    connected: true,
    tabAct: vi.fn(async (_url: string, intent: string, params?: Record<string, unknown>) =>
      intent === "readMedia" ? media : { value: (params as { prop?: string })?.prop === "textContent" ? "LIVE" : 42 },
    ),
    ...over,
  };
}

describe("evalBrowserCondition — чтение через ext + сравнение", () => {
  it("video.currentTime ≥ порога → met, читает интентом readMedia", async () => {
    const ext = mockExt();
    const r = await evalBrowserCondition(ext, { kind: "browser", prop: "currentTime", op: ">=", value: 1560 });
    expect(r.met).toBe(true);
    expect(r.detail).toContain("currentTime=1600");
    expect(ext.tabAct).toHaveBeenCalledWith("", "readMedia", {}, undefined);
  });

  it("не дошёл до порога → met:false", async () => {
    const ext = mockExt({}, { currentTime: 1400, duration: 3600, paused: false });
    const r = await evalBrowserCondition(ext, { kind: "browser", prop: "currentTime", op: ">=", value: 1560 });
    expect(r.met).toBe(false);
  });

  it("gone:true инвертирует (ждать, пока перестанет выполняться)", async () => {
    const ext = mockExt();
    const r = await evalBrowserCondition(ext, { kind: "browser", prop: "currentTime", op: ">=", value: 1560, gone: true });
    expect(r.met).toBe(false); // условие ВЫПОЛНЕНО (1600≥1560), а gone ждёт обратного → not met
  });

  it("paused == false → met (пауза снята)", async () => {
    const ext = mockExt();
    const r = await evalBrowserCondition(ext, { kind: "browser", prop: "paused", op: "==", value: false });
    expect(r.met).toBe(true);
  });

  it("селектор+prop → интент getValue", async () => {
    const ext = mockExt();
    const r = await evalBrowserCondition(ext, { kind: "browser", selector: ".title", prop: "textContent", op: "contains", value: "LIVE" });
    expect(r.met).toBe(true);
    // contains уходит В СТРАНИЦУ (сравнение по полному тексту — фикс «слово дальше 200-го символа»).
    expect(ext.tabAct).toHaveBeenCalledWith("", "getValue", { selector: ".title", prop: "textContent", contains: "LIVE" }, undefined);
  });

  it("расширение не подключено → бросает (вызывающий трактует как «ещё не дождались»/транзиент)", async () => {
    const ext = mockExt({ connected: false });
    await expect(evalBrowserCondition(ext, { kind: "browser", value: 1560 })).rejects.toThrow(/не подключено/);
  });

  it("(ревью #6) при selector дефолтный prop = textContent, НЕ currentTime", async () => {
    const ext = mockExt();
    await evalBrowserCondition(ext, { kind: "browser", selector: ".title", op: "contains", value: "LIVE" }); // prop опущен
    expect(ext.tabAct).toHaveBeenCalledWith("", "getValue", { selector: ".title", prop: "textContent", contains: "LIVE" }, undefined);
  });

  it("(ревью #6) НЕЧИТАЕМОЕ значение (undefined) → met:false даже с gone:true (не ложное «исчезло»)", async () => {
    // getValue вернул value:undefined (нет такого prop на элементе) — это НЕ «условие ложно», а «не прочитано».
    const ext = mockExt({ tabAct: vi.fn(async () => ({})) }); // {value:undefined}
    const r1 = await evalBrowserCondition(ext, { kind: "browser", selector: "#x", prop: "nope", op: "contains", value: "y" });
    expect(r1.met).toBe(false);
    const r2 = await evalBrowserCondition(ext, { kind: "browser", selector: "#x", prop: "nope", op: "contains", value: "y", gone: true });
    expect(r2.met).toBe(false); // gone НЕ инвертирует нечитаемое в met:true
  });
});

describe("BlankPageError — слепая вкладка (эпизод «не сказал про доставку» 2026-07-24)", () => {
  const blankExt = (): BrowserReader => ({
    connected: true,
    tabAct: vi.fn(async () => ({ value: "\n        \n                \n              \n" })),
  });

  it("пустой textContent по body → BlankPageError (слепота ≠ «условие не выполнено»)", async () => {
    const cond = { kind: "browser", selector: "body", prop: "textContent", op: "contains", value: "доставлен" } as never;
    await expect(evalBrowserCondition(blankExt(), cond)).rejects.toThrow(/пустой текст/);
  });

  it("gone:true по body при пустой странице ТОЖЕ бросает (иначе выгруженная вкладка = ложное «исчезло»)", async () => {
    const cond = { kind: "browser", selector: "body", prop: "textContent", op: "contains", value: "доставлен", gone: true } as never;
    await expect(evalBrowserCondition(blankExt(), cond)).rejects.toThrow(/пустой текст/);
  });

  it("УЗКИЙ селектор с пустым текстом — легитимное состояние, НЕ слепота (met по семантике)", async () => {
    const cond = { kind: "browser", selector: "#status-badge", prop: "textContent", op: "contains", value: "доставлен" } as never;
    const r = await evalBrowserCondition(blankExt(), cond);
    expect(r.met).toBe(false); // честное «не содержит», без throw
  });

  it("непустая страница → обычное сравнение (регресс)", async () => {
    const ext: BrowserReader = {
      connected: true,
      tabAct: vi.fn(async () => ({ value: "Ваш заказ доставлен. Приятного аппетита!" })),
    };
    const cond = { kind: "browser", selector: "body", prop: "textContent", op: "contains", value: "доставлен" } as never;
    const r = await evalBrowserCondition(ext, cond);
    expect(r.met).toBe(true);
  });
});

describe("recover — self-heal наблюдаемой вкладки (эпизод «перекрыл вкладку» 2026-07-24)", () => {
  const textCond = { kind: "browser", selector: "body", prop: "textContent", op: "contains", value: "доставлен", tabId: 1 } as never;

  it("recover:true → расширению уходит флаг починки вкладки", async () => {
    const tabAct = vi.fn(async (_u: string, _i: string, _p?: Record<string, unknown>, _t?: number) => ({ value: "заказ доставлен" }));
    await evalBrowserCondition({ connected: true, tabAct }, textCond, { recover: true });
    expect(tabAct.mock.calls[0]?.[2]).toMatchObject({ recover: true, selector: "body", prop: "textContent" });
  });

  it("без recover флаг НЕ уходит (обычные чтения вкладку пользователя не чинят)", async () => {
    const tabAct = vi.fn(async (_u: string, _i: string, _p?: Record<string, unknown>, _t?: number) => ({ value: "заказ доставлен" }));
    await evalBrowserCondition({ connected: true, tabAct }, textCond);
    expect(tabAct.mock.calls[0]?.[2]).not.toHaveProperty("recover");
  });

  it("МЕДИА-условие не чинится даже при recover:true (reload сбросил бы позицию, которую ждём)", async () => {
    const tabAct = vi.fn(async (_u: string, _i: string, _p?: Record<string, unknown>, _t?: number) => ({ currentTime: 1600, duration: 3600, paused: false }));
    const mediaCond = { kind: "browser", prop: "currentTime", op: ">=", value: 1560, tabId: 1 } as never;
    await evalBrowserCondition({ connected: true, tabAct }, mediaCond, { recover: true });
    expect(tabAct.mock.calls[0]?.[2]).not.toHaveProperty("recover");
  });

  it("вкладку переоткрыли → патч с новым tabId/url наверх (следующий тик смотрит на живую вкладку)", async () => {
    const tabAct = vi.fn(async () => ({ value: "заказ доставлен", matched: true, len: 900, tabId: 777, tabUrl: "https://shop.ru/order/1", recovered: "reopened" }));
    const cond = { ...(textCond as object), url: "https://shop.ru/order/1" } as never;
    const r = await evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true });
    expect(r.met).toBe(true);
    expect(r.patch).toEqual({ tabId: 777 });
    expect(r.detail).toMatch(/восстановлена: reopened/);
  });

  // Ревью 2026-07-24 (CRITICAL): без ремонта патча быть не должно — findTargetTab мог подставить ЧУЖУЮ
  // вкладку (фолбэк по хосту/активная), и патч НАВСЕГДА переклеил бы наблюдение на чужую страницу.
  it("БЕЗ ремонта (recovered отсутствует) патча нет, даже если tabId в ответе другой", async () => {
    const tabAct = vi.fn(async () => ({ value: "заказ доставлен", matched: true, len: 900, tabId: 999, tabUrl: "https://other.ru/x" }));
    const r = await evalBrowserCondition({ connected: true, tabAct }, textCond, { recover: true });
    expect(r.patch).toBeUndefined();
  });

  it("ремонт увёл на ДРУГОЙ хост → url в патч НЕ пишем (это уже не та страница)", async () => {
    const tabAct = vi.fn(async () => ({ value: "заказ доставлен", matched: true, len: 900, tabId: 5, tabUrl: "https://evil.ru/x", recovered: "reopened" }));
    const cond = { ...(textCond as object), url: "https://shop.ru/order/1" } as never;
    const r = await evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true });
    expect(r.patch).toEqual({ tabId: 5 });
    expect(r.patch?.url).toBeUndefined();
  });

  it("пусто ДАЖЕ после починки → честная BlankPageError (не «условие не выполнено»)", async () => {
    const tabAct = vi.fn(async () => ({ value: "", len: 0, tabId: 1, recovered: "reloaded" }));
    await expect(evalBrowserCondition({ connected: true, tabAct }, textCond, { recover: true })).rejects.toThrow(/пустой текст/);
  });
});

// 🔴 ПЕРВОПРИЧИНА живого эпизода «не сказал про доставку» (ревью 2026-07-24, CRITICAL): расширение
// отдаёт значение обрезанным до 200 символов, а «Доставлен» на реальной странице стоит дальше — серверный
// includes по обрезку не находил его НИКОГДА. Теперь сравнение подстроки делается НА СТРАНИЦЕ.
describe("contains — сравнение по ПОЛНОМУ тексту страницы, а не по обрезку", () => {
  const cond = { kind: "browser", selector: "body", prop: "textContent", op: "contains", value: "доставлен", tabId: 1 } as never;

  it("искомая подстрока уходит в страницу параметром contains", async () => {
    const tabAct = vi.fn(async (_u: string, _i: string, _p?: Record<string, unknown>, _t?: number) => ({ value: "…заказ доставлен…", matched: true, len: 5000 }));
    await evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true });
    expect(tabAct.mock.calls[0]?.[2]).toMatchObject({ contains: "доставлен", recoverIfBlank: true });
  });

  it("matched:true при значении-СНИППЕТЕ → met (слово было за 200-м символом — прежде терялось)", async () => {
    const tabAct = vi.fn(async () => ({ value: "…ваш заказ доставлен курьером…", matched: true, len: 12000 }));
    const r = await evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true });
    expect(r.met).toBe(true);
  });

  it("matched:false при непустой странице → честное «ещё не выполнено», без ошибки слепоты", async () => {
    const tabAct = vi.fn(async () => ({ value: "Готовим ваш заказ", matched: false, len: 8000 }));
    const r = await evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true });
    expect(r.met).toBe(false);
  });

  it("gone:true инвертирует matched (ждём ИСЧЕЗНОВЕНИЯ текста)", async () => {
    const tabAct = vi.fn(async () => ({ value: "…", matched: false, len: 8000 }));
    const goneCond = { ...(cond as object), gone: true } as never;
    const r = await evalBrowserCondition({ connected: true, tabAct }, goneCond, { recover: true });
    expect(r.met).toBe(true);
  });

  // Ревью р2 (HIGH): выгруженная вкладка отдаёт не "", а «\n   \n» — по сырой длине это «непусто»,
  // и слепота снова маскировалась бы под честное «условие не выполнено» (симптом живого эпизода).
  it("страница из ОДНИХ ПРОБЕЛОВ (blank:true при len>0) → BlankPageError, а не «условие не выполнено»", async () => {
    const tabAct = vi.fn(async () => ({ value: "", matched: false, len: 16, blank: true }));
    await expect(evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true })).rejects.toThrow(/пустой текст/);
  });

  it("ремонт на кулдауне → BlankPageError.throttled (наблюдение НЕ суспендится преждевременно)", async () => {
    const tabAct = vi.fn(async () => ({ value: "", matched: false, len: 8, blank: true, reviveThrottled: true }));
    await evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true }).then(
      () => expect.fail("ожидалась BlankPageError"),
      (e: unknown) => {
        expect(e).toBeInstanceOf(BlankPageError);
        expect((e as InstanceType<typeof BlankPageError>).throttled).toBe(true);
      },
    );
  });

  it("непустая страница без совпадения (blank:false) → met:false без ошибки", async () => {
    const tabAct = vi.fn(async () => ({ value: "Готовим заказ", matched: false, len: 500, blank: false }));
    const r = await evalBrowserCondition({ connected: true, tabAct }, cond, { recover: true });
    expect(r.met).toBe(false);
  });

  it("УЗКИЙ селектор: recoverIfBlank НЕ ставится (пустой элемент законен — reload живой вкладки запрещён)", async () => {
    const tabAct = vi.fn(async (_u: string, _i: string, _p?: Record<string, unknown>, _t?: number) => ({ value: "", matched: false, len: 0 }));
    const narrow = { kind: "browser", selector: "#status", prop: "textContent", op: "contains", value: "доставлен", tabId: 1 } as never;
    const r = await evalBrowserCondition({ connected: true, tabAct }, narrow, { recover: true });
    expect(tabAct.mock.calls[0]?.[2]).not.toHaveProperty("recoverIfBlank");
    expect(r.met).toBe(false); // честное «ещё нет», без BlankPageError
  });
});
