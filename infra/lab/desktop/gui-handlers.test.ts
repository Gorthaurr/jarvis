/** Окна и приложения FakeDesktop: запуск/фокус/закрытие, браузер, window.*, честные ошибки (ничего не «ok» вхолостую). */
import { describe, expect, it } from "vitest";
import { kit } from "./gui-testkit.js";

describe("app.launch / app.focus / app.close", () => {
  it("запуск блокнота создаёт окно с формой результата настоящего клиента и пишет эффект", async () => {
    const k = kit();
    const r = await k.ok({ kind: "app.launch", app: "блокнот" });
    expect(r).toMatchObject({ resolved: "notepad.exe", confirmed: true, windowSeen: true, verified: "process" });
    expect(typeof r.pid).toBe("number");
    expect(typeof r.window.hwnd).toBe("number");
    expect(k.win("notepad").title).toBe("Безымянный — Блокнот");
    expect(k.effects("app.launch")[0]!.detail).toMatchObject({ app: "блокнот", pid: r.pid });
    expect(k.d.snapshot().foregroundHwnd).toBe(r.window.hwnd);
  });

  it("неустановленное приложение — not_found, окна не появилось", async () => {
    const k = kit({ installedApps: ["notepad"] });
    const e = await k.fail({ kind: "app.launch", app: "steam" });
    expect(e.code).toBe("not_found");
    expect(k.d.snapshot().windows).toHaveLength(0);
    expect(k.effects("app.launch")).toHaveLength(0);
  });

  it("одиночное приложение (калькулятор) не плодит окна, а поднимает существующее", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "app.launch", app: "notepad" });
    const r = await k.ok({ kind: "app.launch", app: "калькулятор" });
    expect(r.verified).toBe("appid-already");
    expect(k.d.snapshot().windows.filter((w) => w.process === "CalculatorApp")).toHaveLength(1);
    expect(k.d.snapshot().foregroundHwnd).toBe(k.win("CalculatorApp").hwnd);
  });

  it("app.focus поднимает окно; без запущенного окна — not_found, не «ok»", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "app.launch", app: "calc" });
    expect(k.d.snapshot().foregroundHwnd).toBe(k.win("CalculatorApp").hwnd);
    const r = await k.ok({ kind: "app.focus", app: "notepad" });
    expect(r).toMatchObject({ focused: true, resolved: "notepad" });
    expect(k.d.snapshot().foregroundHwnd).toBe(k.win("notepad").hwnd);
    expect((await k.fail({ kind: "app.focus", app: "discord" })).code).toBe("not_found");
  });

  it("app.close закрывает чистое окно; повторное закрытие — not_found (closed=0)", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    expect(await k.ok({ kind: "app.close", app: "notepad" })).toMatchObject({ closed: 1 });
    expect(k.d.snapshot().windows).toHaveLength(0);
    expect(k.d.snapshot().foregroundHwnd).toBeNull();
    expect((await k.fail({ kind: "app.close", app: "notepad" })).code).toBe("not_found");
  });

  it("несохранённый блокнот при штатном закрытии спрашивает и остаётся (честно: не закрыт); force убивает", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.type", text: "важное" });
    const e = await k.fail({ kind: "app.close", app: "notepad" });
    expect(e.code).toBe("not_found");
    expect(k.effects("window.close.blocked")).toHaveLength(1);
    expect(k.d.snapshot().windows.some((w) => w.title === "Блокнот")).toBe(true); // диалог «Сохранить?»
    expect((await k.ok({ kind: "app.close", app: "notepad", force: true })).closed).toBeGreaterThanOrEqual(1);
    expect(k.d.snapshot().windows).toHaveLength(0);
  });

  it("критичные процессы закрыть нельзя", async () => {
    const k = kit({ windows: [{ process: "explorer", title: "Проводник" }] });
    const e = await k.fail({ kind: "app.close", app: "explorer" });
    expect(e.code).toBe("runtime");
    expect(k.d.snapshot().windows).toHaveLength(1);
  });
});

describe("browser.open", () => {
  it("управляемый инстанс: {url, controlled:true}; в дефолтном — окно браузера с заголовком от страницы", async () => {
    const k = kit({ web: { "https://example.com/": "<title>Пример</title><p>привет</p>" } });
    expect(await k.ok({ kind: "browser.open", url: "https://example.com/" })).toEqual({ url: "https://example.com/", controlled: true });
    const r = await k.ok({ kind: "browser.open", url: "https://example.com/", inDefault: true });
    expect(r).toMatchObject({ inDefault: true, controlled: false });
    expect(k.win("chrome").title).toBe("Пример - Google Chrome");
    expect(k.win("chrome").text).toContain("привет");
  });

  it("второй URL в браузере — новая вкладка того же окна, а не второе окно", async () => {
    const k = kit({ web: { "https://a.ru/": "<title>A</title>", "https://b.ru/": "<title>B</title>" } });
    await k.ok({ kind: "browser.open", url: "https://a.ru/", inDefault: true });
    await k.ok({ kind: "browser.open", url: "https://b.ru/", inDefault: true });
    expect(k.d.snapshot().windows.filter((w) => w.process === "chrome")).toHaveLength(1);
    expect(k.win("chrome").title).toBe("B - Google Chrome");
  });

  it("сайт вне seed — офлайн-вкладка с честным текстом ошибки, не выдуманное содержимое", async () => {
    const k = kit();
    await k.ok({ kind: "browser.open", url: "https://nowhere.example/x", inDefault: true });
    expect(k.win("chrome").text).toContain("Не удаётся");
  });

  it("без установленного браузера — not_found", async () => {
    const k = kit({ installedApps: ["notepad"] });
    expect((await k.fail({ kind: "browser.open", url: "https://a.ru/", inDefault: true })).code).toBe("not_found");
  });
});

describe("window.list / window.focus / window.arrange", () => {
  it("window.list — сверху вниз, с foreground/minimized/monitorIndex/rect", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "app.launch", app: "calc" });
    const { windows } = await k.ok({ kind: "window.list" });
    expect(windows.map((w: any) => w.process)).toEqual(["CalculatorApp", "notepad"]);
    expect(windows[0]).toMatchObject({ foreground: true, minimized: false });
    expect(windows[1].foreground).toBe(false);
    expect(windows[0].rect.w).toBeGreaterThan(0);
    expect(typeof windows[0].hwnd).toBe("number");
  });

  it("window.focus по query и по hwnd; неизвестное окно — ошибка", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "app.launch", app: "calc" });
    const r = await k.ok({ kind: "window.focus", query: "блокнот" });
    expect(r).toMatchObject({ focused: true, title: "Безымянный — Блокнот" });
    expect(k.d.snapshot().foregroundHwnd).toBe(k.win("notepad").hwnd);
    await k.ok({ kind: "window.focus", hwnd: k.win("CalculatorApp").hwnd });
    expect(k.d.snapshot().foregroundHwnd).toBe(k.win("CalculatorApp").hwnd);
    expect((await k.fail({ kind: "window.focus", query: "нет-такого" })).code).toBe("runtime");
    expect((await k.fail({ kind: "window.focus" })).code).toBe("runtime");
  });

  it("свернуть → окно minimized, фокус уходит на соседа; фокус на свёрнутое восстанавливает", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "app.launch", app: "calc" });
    const calc = k.win("CalculatorApp");
    const r = await k.ok({ kind: "window.arrange", hwnd: calc.hwnd, op: "minimize" });
    expect(r).toMatchObject({ minimized: true, monitor: "свёрнуто" });
    expect(k.d.snapshot().foregroundHwnd).toBe(k.win("notepad").hwnd);
    await k.ok({ kind: "window.focus", hwnd: calc.hwnd });
    expect(k.win("CalculatorApp").minimized).toBe(false);
  });

  it("развернуть/восстановить возвращает прежний прямоугольник; перенос на второй монитор меняет monitorIndex", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    const w0 = k.win("notepad");
    const rect0 = { ...w0.rect };
    const mx = await k.ok({ kind: "window.arrange", hwnd: w0.hwnd, op: "maximize" });
    expect(mx).toMatchObject({ maximized: true });
    expect(mx.rect.w).toBe(2560);
    const rs = await k.ok({ kind: "window.arrange", hwnd: w0.hwnd, op: "restore" });
    expect(rs.rect).toEqual(rect0);
    const mv = await k.ok({ kind: "window.arrange", hwnd: w0.hwnd, op: "move", monitor: 1 });
    expect(mv.monitorIndex).toBe(1);
    expect(k.win("notepad").rect.x).toBeGreaterThanOrEqual(2560);
  });

  it("перенос на несуществующий монитор и без монитора — ошибка, окно не тронуто", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    const before = { ...k.win("notepad").rect };
    expect((await k.fail({ kind: "window.arrange", query: "notepad", op: "move", monitor: 7 })).code).toBe("runtime");
    expect((await k.fail({ kind: "window.arrange", query: "notepad", op: "move" })).code).toBe("runtime");
    expect(k.win("notepad").rect).toEqual(before);
    expect((await k.fail({ kind: "window.arrange", query: "призрак", op: "minimize" })).code).toBe("runtime");
  });
});
