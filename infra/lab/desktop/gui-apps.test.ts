/** Модели приложений FakeDesktop: проводник, браузер, мессенджер, окна из seed — поведение, а не форма. */
import { describe, expect, it } from "vitest";
import { type Kit, grant, kit } from "./gui-testkit.js";

/**
 * Клавиша, которую §14 судит как «коммит» (allowlist shared/commit-keys: Ctrl+L, Alt+←, Ctrl+T в браузере — не безопасны):
 * первый заход без гранта обязан быть denied с needsApproval, второй — с грантом из этого ответа — проходит.
 */
async function approvedKey(k: Kit, combo: string): Promise<void> {
  const denied = await k.fail({ kind: "input.key", combo });
  expect(denied.code).toBe("denied");
  const na = denied.data.needsApproval as { signature: string; process: string };
  await k.ok({ kind: "input.key", combo, ...grant(na.signature, na.process) });
}

describe("проводник", () => {
  const seed = { files: { "Desktop/todo.txt": "купить хлеб", "Documents/a/b.md": "# b" } };

  it("показывает каталог виртуальной ФС; двойной клик по папке — навигация, по файлу — открывается в блокноте", async () => {
    const k = kit(seed);
    await k.ok({ kind: "app.launch", app: "проводник" });
    expect(k.win("explorer").text).toContain("todo.txt");
    await k.ok({ kind: "input.click", target: { by: "role", role: "listitem", name: "todo.txt" }, method: "physical", count: 2 });
    expect(k.win("notepad").text).toBe("купить хлеб");
  });

  it("адресная строка: setValue в существующий каталог переходит, в несуществующий — нет (честно)", async () => {
    const k = kit(seed);
    await k.ok({ kind: "app.launch", app: "explorer" });
    const h = Number((await k.ok({ kind: "ui.ground", query: { role: "edit" } })).handle);
    await k.ok({ kind: "ui.invoke", target: { by: "handle", handle: h }, pattern: "setValue", value: "C:\\Users\\lab\\Documents" });
    expect(k.win("explorer").title).toBe("Документы");
    expect(k.win("explorer").text).toContain("a");
    await k.ok({ kind: "ui.invoke", target: { by: "handle", handle: h }, pattern: "setValue", value: "C:\\Нет\\Такого" });
    expect(k.win("explorer").title).toBe("Документы");
    expect(k.effects("explorer.navigate.failed")).toHaveLength(1);
  });

  it("Delete на выбранном файле удаляет его из ФС песочницы (эффект fs.delete)", async () => {
    const k = kit(seed);
    await k.ok({ kind: "app.launch", app: "explorer" });
    await k.ok({ kind: "input.click", target: { by: "role", role: "listitem", name: "todo.txt" }, method: "physical" });
    await k.ok({ kind: "input.key", combo: "Delete" });
    expect(k.d.snapshot().files["C:/Users/lab/Desktop/todo.txt"]).toBeUndefined();
    expect(k.effects("fs.delete")[0]!.detail).toMatchObject({ path: "C:/Users/lab/Desktop/todo.txt", via: "explorer" });
  });

  it("открытие файла без подходящего приложения — not_found, не ok", async () => {
    const k = kit({ files: { "Desktop/x.bin": "\u0000\u0001" } });
    expect((await k.fail({ kind: "app.launch", app: "C:\\Users\\lab\\Desktop\\x.bin" })).code).toBe("not_found");
  });
});

describe("браузер", () => {
  const web = { "https://ya.ru/": "<title>Яндекс</title>Поиск", "https://news.ru/": "<title>Новости</title>Главное за день" };

  it("Ctrl+L, набор адреса, Enter — навигация; заголовок и текст окна от страницы", async () => {
    const k = kit({ web });
    await k.ok({ kind: "app.launch", app: "chrome" });
    await approvedKey(k, "Ctrl+L");
    await k.ok({ kind: "input.type", text: "ya.ru" });
    await approvedKey(k, "Enter");
    expect(k.win("chrome").title).toBe("Яндекс - Google Chrome");
    expect(k.win("chrome").text).toContain("Поиск");
    expect(k.effects("browser.navigate").pop()!.detail).toMatchObject({ url: "https://ya.ru", loaded: true }); // без слэша находит страницу seed
  });

  it("Alt+Left/Right ходят по истории, Ctrl+T открывает вкладку, Ctrl+W закрывает", async () => {
    const k = kit({ web });
    await k.ok({ kind: "browser.open", url: "https://ya.ru/", inDefault: true });
    await approvedKey(k, "Ctrl+L");
    await k.ok({ kind: "input.type", text: "https://news.ru/" });
    await approvedKey(k, "Enter");
    expect(k.win("chrome").title).toBe("Новости - Google Chrome");
    await approvedKey(k, "Alt+Left");
    expect(k.win("chrome").title).toBe("Яндекс - Google Chrome");
    await approvedKey(k, "Alt+Right");
    expect(k.win("chrome").title).toBe("Новости - Google Chrome");
    await approvedKey(k, "Ctrl+T");
    expect(k.win("chrome").title).toBe("Новая вкладка - Google Chrome");
    await approvedKey(k, "Ctrl+W");
    expect(k.win("chrome").title).toBe("Новости - Google Chrome");
  });

  it("печать в страницу (фокус не в адресной строке) не принимается: accepted:false", async () => {
    const k = kit({ web });
    await k.ok({ kind: "browser.open", url: "https://ya.ru/", inDefault: true });
    await k.ok({ kind: "input.type", text: "не туда" });
    expect(k.effects("input.type")[0]!.detail.accepted).toBe(false);
  });

  it("UIA видит адресную строку и вкладки; клик по вкладке переключает", async () => {
    const k = kit({ web });
    await k.ok({ kind: "browser.open", url: "https://ya.ru/", inDefault: true });
    await k.ok({ kind: "browser.open", url: "https://news.ru/", inDefault: true });
    const snap = await k.ok({ kind: "ui.snapshot" });
    expect(snap.items.filter((i: any) => i.role === "tabitem").map((i: any) => i.name)).toEqual(["Яндекс", "Новости"]);
    await k.ok({ kind: "input.click", target: { by: "role", role: "tabitem", name: "Яндекс" } });
    expect(k.win("chrome").title).toBe("Яндекс - Google Chrome");
  });
});

describe("мессенджер", () => {
  const seed = { windows: [{ process: "Telegram", title: "Избранное — Telegram" }] };

  it("выбор чата меняет заголовок и историю; поиск вводится отдельно от сообщения", async () => {
    const k = kit(seed);
    await k.ok({ kind: "input.click", target: { by: "role", role: "listitem", name: "Катя" } });
    expect(k.win("Telegram").title).toBe("Катя — Telegram");
    expect(k.win("Telegram").text).toContain("Ты завтра придёшь");
    await approvedKey(k, "Ctrl+F");
    await k.ok({ kind: "input.type", text: "поиск" });
    const s = await k.ok({ kind: "ui.ground", query: { role: "edit", name: "Поиск" } });
    expect(s.name).toBe("Поиск");
    expect(k.effects("app.message.sent")).toHaveLength(0);
  });

  it("многострочная печать с \\n в мессенджере = Enter: без гранта отказ, черновик не уходит", async () => {
    const k = kit(seed);
    const e = await k.fail({ kind: "input.type", text: "раз\nдва" });
    expect(e.code).toBe("denied");
    expect(k.effects("app.message.sent")).toHaveLength(0);
    expect(k.effects("input.type")).toHaveLength(0);
  });

  it("грант на «Отправить» списывается: кнопка уходит один раз, сообщение в истории окна", async () => {
    const k = kit(seed);
    await k.ok({ kind: "input.type", text: "привет" });
    const sig = (await k.fail({ kind: "gui.act", target: "Отправить" })).data.needsApproval.signature as string;
    await k.ok({ kind: "gui.act", target: "Отправить", ...grant(sig, "telegram") });
    expect(k.effects("app.message.sent")).toHaveLength(1);
    expect(k.win("Telegram").text).toContain("привет");
    expect((await k.fail({ kind: "gui.act", target: "Отправить" })).code).toBe("denied"); // пустой черновик уже не отправляется, а вот гранта нет
  });
});

describe("окна из seed и общие правила", () => {
  it("окно из seed получает поведение по процессу (калькулятор из seed — рабочий)", async () => {
    const k = kit({ windows: [{ process: "CalculatorApp", title: "Калькулятор", text: "0" }] });
    await k.ok({ kind: "input.type", text: "2+2=" });
    expect(k.win("CalculatorApp").text).toBe("4");
  });

  it("сброс desktop.reset рождает состояние заново: кадры и вуаль не переживают", async () => {
    const k = kit();
    const cap = await k.ok({ kind: "screen.capture", monitor: 0 });
    await k.ok({ kind: "screen.selection", op: "start" });
    k.d.reset();
    expect((await k.fail({ kind: "screen.capture", rect: { x: 0, y: 0, w: 5, h: 5, frame: cap.frameId } })).code).toBe("not_found");
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.type", text: "ok" }); // вуали больше нет
  });

  it("кнопки заголовка окна работают через UIA: «Свернуть» сворачивает, «Закрыть» закрывает чистое окно", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "input.click", target: { by: "role", role: "button", name: "Свернуть" } });
    expect(k.win("CalculatorApp").minimized).toBe(true);
    await k.ok({ kind: "window.focus", query: "калькулятор" });
    await k.ok({ kind: "input.click", target: { by: "role", role: "button", name: "Закрыть" } });
    expect(k.d.snapshot().windows).toHaveLength(0);
  });

  it("Alt+Tab переключает окна; с одним окном — accepted:false", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.key", combo: "Alt+Tab" });
    expect(k.effects("input.key")[0]!.detail.accepted).toBe(false);
    await k.ok({ kind: "app.launch", app: "calc" });
    await k.ok({ kind: "input.key", combo: "Alt+Tab" });
    expect(k.d.snapshot().foregroundHwnd).toBe(k.win("notepad").hwnd);
  });
});
