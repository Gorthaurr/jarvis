import { describe, expect, it, vi } from "vitest";
import { type BrowserReader, compareBrowserValue, evalBrowserCondition, isBrowserCondition } from "./browser-condition.js";

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
    expect(ext.tabAct).toHaveBeenCalledWith("", "getValue", { selector: ".title", prop: "textContent" }, undefined);
  });

  it("расширение не подключено → бросает (вызывающий трактует как «ещё не дождались»/транзиент)", async () => {
    const ext = mockExt({ connected: false });
    await expect(evalBrowserCondition(ext, { kind: "browser", value: 1560 })).rejects.toThrow(/не подключено/);
  });

  it("(ревью #6) при selector дефолтный prop = textContent, НЕ currentTime", async () => {
    const ext = mockExt();
    await evalBrowserCondition(ext, { kind: "browser", selector: ".title", op: "contains", value: "LIVE" }); // prop опущен
    expect(ext.tabAct).toHaveBeenCalledWith("", "getValue", { selector: ".title", prop: "textContent" }, undefined);
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
