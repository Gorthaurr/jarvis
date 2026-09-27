/** §14 гейт необратимых кликов (причина №4 USER_SCENARIOS_2026-09-02) — чистые правила. */
import { describe, expect, it } from "vitest";
import {
  COMMIT_WORDS_RE,
  assessWebCommit,
  hostOfUrl,
  lastWebTarget,
  rememberUiHandles,
  rememberWebTarget,
  riskyHostCategory,
  uiHandleLabel,
} from "./commit-gate.js";
import type { ToolContext } from "./dispatch.js";
import { handleInfo } from "./gate-memory.js";
import { guiPlan } from "./gui-gate.js";
import { parseForeground } from "./gui-intents.js";

/**
 * W2 П3: суд GUI по запросу — `guiPlan` (место + подписи shared). Возвращает подписи намерений-коммитов или null.
 * `session` — общий объект сессии (память handle из снимка).
 */
function gui(a: { foregroundProcess: string; app?: string; tool: string; input: Record<string, unknown>; session?: object }): string[] | null {
  const ctx = { session: a.session ?? {}, systemContext: () => `Окна: 3 · На переднем плане: ${a.foregroundProcess} «Окно» · Пользователь: за ПК` } as unknown as ToolContext;
  const intents = guiPlan(a.tool, a.app ? { ...a.input, app: a.app } : a.input, ctx).intents;
  return intents.length ? intents.map((i) => i.signature) : null;
}

describe("riskyHostCategory / hostOfUrl", () => {
  it("суффиксы хостов: банк, маркетплейс, соцсеть, мессенджер; www и поддомены; чужой хост — null", () => {
    expect(riskyHostCategory("online.sberbank.ru")).toBe("bank");
    expect(riskyHostCategory("www.ozon.ru")).toBe("market");
    expect(riskyHostCategory("studio.youtube.com")).toBe("social");
    expect(riskyHostCategory("web.whatsapp.com")).toBe("messenger");
    expect(riskyHostCategory("example.com")).toBeNull();
    expect(riskyHostCategory("notozon.ru")).toBeNull(); // не суффикс по точке
  });
  it("hostOfUrl принимает URL и голый хост", () => {
    expect(hostOfUrl("https://www.ozon.ru/cart?x=1")).toBe("www.ozon.ru");
    expect(hostOfUrl("ozon.ru")).toBe("ozon.ru");
    expect(hostOfUrl("")).toBe("");
  });
});

describe("assessWebCommit", () => {
  it("клик «Опубликовать» на YouTube Studio — коммит; клик «Смотреть позже» — нет", () => {
    expect(assessWebCommit({ host: "studio.youtube.com", intent: "click", params: { text: "Опубликовать" } })?.what).toMatch(/Опубликовать/u);
    expect(assessWebCommit({ host: "studio.youtube.com", intent: "click", params: { text: "Смотреть позже" } })).toBeNull();
  });
  it("Enter/submit/type+enter в мессенджере и на маркетплейсе — коммит; на нейтральном хосте — нет", () => {
    expect(assessWebCommit({ host: "web.whatsapp.com", intent: "type", params: { text: "привет", enter: true } })?.what).toMatch(/отправка сообщения/u);
    expect(assessWebCommit({ host: "www.wildberries.ru", intent: "submit" })?.what).toMatch(/отправка формы/u);
    expect(assessWebCommit({ host: "docs.example.com", intent: "type", params: { text: "x", enter: true } })).toBeNull();
  });
  it("W1: key-сочетания Enter (Ctrl/Shift/Alt+Enter) в мессенджере — коммит; Tab/Ctrl+A — нет; поле combo, как в схеме", () => {
    // Таблица всех форм — стык с расширением (key-combo-contract.test.ts, fixtures/key-combos.json).
    for (const combo of ["Enter", "Ctrl+Enter", "shift+enter", "Return", "Alt+Enter"]) {
      expect(assessWebCommit({ host: "web.telegram.org", intent: "key", params: { combo } }), combo).not.toBeNull();
    }
    for (const combo of ["Tab", "Ctrl+A", "Escape"]) {
      expect(assessWebCommit({ host: "web.telegram.org", intent: "key", params: { combo } }), combo).toBeNull();
    }
    expect(assessWebCommit({ host: "docs.example.com", intent: "key", params: { combo: "Ctrl+Enter" } })).toBeNull(); // не опасное место
  });
  it("подпись ref из последнего inspect судится как текст клика («Оплатить» по ref)", () => {
    expect(assessWebCommit({ host: "www.ozon.ru", intent: "click", params: { ref: "e3_5" }, label: "button Оплатить заказ" })?.summary).toMatch(/маркетплейс/u);
    expect(assessWebCommit({ host: "www.ozon.ru", intent: "click", params: { ref: "e3_5" } })).toBeNull(); // подписи нет — судить нечего
  });
  it("клик без имени (селектор/координаты) на опасном хосте — не гейтится (осознанный предел)", () => {
    expect(assessWebCommit({ host: "online.sberbank.ru", intent: "click", params: { selector: "#btn-7" } })).toBeNull();
    expect(assessWebCommit({ host: "online.sberbank.ru", intent: "scroll", params: { dy: 300 } })).toBeNull();
  });
});

// W1 (B-5): удаление необратимо так же, как отправка — «Удалить навсегда» в почте уходило без вопроса владельцу.
describe("W1: глаголы удаления в COMMIT_WORDS_RE (общий список веба, GUI-гейта и клиентского рубежа)", () => {
  it("«Удалить», «Удалить навсегда», «Удаление аккаунта», «Стереть», Delete/Erase — коммит", () => {
    for (const s of ["Удалить", "Удалить навсегда", "Удаление аккаунта", "удалите чат", "Стереть всё", "Delete", "Delete forever", "Erase disk"]) {
      expect(COMMIT_WORDS_RE.test(s), s).toBe(true);
    }
  });
  it("не удаление: «Удалённый рабочий стол», «удаленный доступ», «удалёнка», «Не удалось», папка «Deleted», undelete — НЕ коммит", () => {
    for (const s of ["Удалённый рабочий стол", "удаленный доступ", "Работа на удалёнке", "Не удалось загрузить", "Deleted items", "Undelete", "Eraser tool"]) {
      expect(COMMIT_WORDS_RE.test(s), s).toBe(false);
    }
  });
  it("проводка: клик «Удалить навсегда» в веб-почте спрашивает, клик по папке «Удалённые» — нет; act «Удалить» в Telegram — коммит", () => {
    expect(assessWebCommit({ host: "mail.google.com", intent: "click", params: { text: "Удалить навсегда" } })?.what).toMatch(/Удалить навсегда/u);
    expect(assessWebCommit({ host: "mail.google.com", intent: "click", params: { text: "Удалённые" } })).toBeNull();
    expect(gui({ foregroundProcess: "Telegram", tool: "act", input: { target: "Удалить для всех" } })).toEqual(["click:удалить для всех"]);
  });
});

describe("W2 П3: суд GUI по запросу (guiPlan) + передний план из живого снимка", () => {
  const ctx1c = "Окна: 5 · На переднем плане: 1cv8 «Бухгалтерия предприятия» · Пользователь: за ПК";
  it("процесс и заголовок из живого снимка; Enter в 1С и вызов «Провести» — коммит; «Печать» — тоже (allowlist ЭДО)", () => {
    expect(parseForeground(ctx1c)).toEqual({ process: "1cv8", title: "Бухгалтерия предприятия" });
    const session = {};
    rememberUiHandles(session, { items: [{ handle: 7, role: "Button", name: "Провести и закрыть" }, { handle: 8, role: "Button", name: "Печать" }, { handle: 9, role: "Button", name: "Закрыть" }] });
    expect(gui({ foregroundProcess: "1cv8", tool: "input_key", input: { combo: "enter" } })).toEqual(["key:enter"]);
    const invoke = (h: string) => gui({ session, foregroundProcess: "1cv8", tool: "ui_invoke", input: { target: { by: "handle", handle: h }, pattern: "invoke" } });
    expect(invoke("7")).toEqual(["click:провести и закрыть"]);
    // Решение владельца №6: в мессенджере/банке/ЭДО безопасны только перечисленные цели — «Печать» спросит (цена allowlist'а).
    expect(invoke("8")).toEqual(["click:печать"]);
    expect(invoke("9")).toBeNull(); // навигационная кнопка
    expect(gui({ foregroundProcess: "1cv8", tool: "input_key", input: { combo: "enter", mode: "up" } })).toBeNull();
  });
  it("Enter в Telegram Desktop — коммит; в Блокноте — ничего; координатный клик — ничего; клик по роли «Отправить» — коммит", () => {
    expect(gui({ foregroundProcess: "Telegram", tool: "input_key", input: { combo: "Enter" } })).toEqual(["key:enter"]);
    expect(gui({ foregroundProcess: "notepad", tool: "input_key", input: { combo: "enter" } })).toBeNull();
    expect(gui({ foregroundProcess: "Discord", tool: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } })).toBeNull();
    expect(gui({ foregroundProcess: "Discord", tool: "input_click", input: { target: { by: "role", role: "Button", name: "Отправить" } } })).toEqual(["click:отправить"]);
  });
  it("память handle → ТОЛЬКО имя (роль и секрет отдельно) из ui_snapshot; последняя цель web_open", () => {
    const session = {};
    rememberUiHandles(session, { items: [{ handle: 11, role: "Button", name: "Провести" }, { handle: 12, role: "Edit", name: "", value: "•••" }] });
    expect(uiHandleLabel(session, 11)).toBe("Провести");
    expect(uiHandleLabel(session, "11")).toBe("Провести"); // S-1: handle в цели — строка
    expect(handleInfo(session, 12)).toEqual({ label: "", role: "Edit", secret: true });
    expect(uiHandleLabel(session, 99)).toBeUndefined();
    rememberWebTarget(session, "https://www.ozon.ru/cart");
    expect(lastWebTarget(session)).toBe("https://www.ozon.ru/cart");
    expect(lastWebTarget({})).toBe("");
  });
});

describe("W4 act — тот же §14-гейт, что у input_key/input_click", () => {
  it("do:key Enter в мессенджере → коммит; Ctrl+A → нет (allowlist клавиш); Alt+S в почте → да", () => {
    expect(gui({ foregroundProcess: "Telegram", tool: "act", input: { do: "key", combo: "Enter" } })).toEqual(["key:enter"]);
    expect(gui({ foregroundProcess: "Telegram", tool: "act", input: { do: "key", combo: "Ctrl+A" } })).toBeNull();
    expect(gui({ foregroundProcess: "outlook", tool: "act", input: { do: "key", combo: "Alt+S" } })).toEqual(["key:alt+s"]);
  });

  it("клик по «Провести»/«Отправить» (строка или {text}) → коммит; печать и клик по «Настройки»/чату/в блокноте → нет", () => {
    expect(gui({ foregroundProcess: "1cv8", tool: "act", input: { target: "Провести" } })).toEqual(["click:провести"]);
    expect(gui({ foregroundProcess: "Telegram", tool: "act", input: { target: { text: "Отправить", role: "Button" }, do: "double" } })).toEqual(["click:отправить"]);
    expect(gui({ foregroundProcess: "Telegram", tool: "act", input: { target: "Отправить", do: "type", text: "x" } })).toBeNull();
    expect(gui({ foregroundProcess: "Telegram", tool: "act", input: { target: "Настройки" } })).toBeNull();
    expect(gui({ foregroundProcess: "Telegram", tool: "act", input: { target: "Катя" } })).toBeNull(); // роль неизвестна — судит клиент
    expect(gui({ foregroundProcess: "notepad", tool: "act", input: { target: "Отправить" } })).toBeNull();
  });

  // Ревью 2026-09-24 (контроль-1 №1): app — свободная строка модели; «дискорд»/«Telegram Desktop» окно находили,
  // а якорный регэксп процесса их не узнавал → Enter уходил человеку без вопроса.
  // Контроль-2: в почтовом клиенте перевод строки — абзац письма; «3ds Max»/«Zoom Player» — не мессенджеры.
  it("почта: многострочная печать без вопроса; «3ds Max»/«Zoom Player» не мессенджер, «Zoom» — да", () => {
    expect(gui({ foregroundProcess: "outlook", tool: "input_type", input: { text: "Добрый день,\nспасибо" } })).toBeNull();
    expect(gui({ foregroundProcess: "Telegram", tool: "input_type", input: { text: "ок\n" } })).toEqual(["key:enter"]);
    expect(gui({ foregroundProcess: "chrome", app: "3ds Max", tool: "act", input: { do: "key", combo: "Enter" } })).toBeNull();
    expect(gui({ foregroundProcess: "chrome", app: "Zoom Player", tool: "act", input: { do: "key", combo: "Enter" } })).toBeNull();
    expect(gui({ foregroundProcess: "chrome", app: "Zoom", tool: "act", input: { do: "key", combo: "Enter" } })).toEqual(["key:enter"]);
  });

  it("act{app} судится по имени из app нестрого: «дискорд», «Telegram Desktop», «телега» → коммит; «notepad» → нет", () => {
    for (const app of ["дискорд", "Telegram Desktop", "телега", "WhatsApp.exe", "1С:Предприятие"]) {
      expect(gui({ foregroundProcess: "chrome", app, tool: "act", input: { do: "key", combo: "Enter" } }), app).toEqual(["key:enter"]);
    }
    expect(gui({ foregroundProcess: "Telegram", app: "notepad", tool: "act", input: { do: "key", combo: "Enter" } })).toBeNull();
    expect(gui({ foregroundProcess: "chrome", app: "Блокнот", tool: "act", input: { target: "Отправить" } })).toBeNull();
  });
});
