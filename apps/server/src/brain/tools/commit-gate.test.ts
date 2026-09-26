/** §14 гейт необратимых кликов (причина №4 USER_SCENARIOS_2026-09-02) — чистые правила. */
import { describe, expect, it } from "vitest";
import {
  COMMIT_WORDS_RE,
  assessGuiCommit,
  assessWebCommit,
  hostOfUrl,
  lastWebTarget,
  parseForegroundProcess,
  rememberUiHandles,
  rememberWebTarget,
  riskyHostCategory,
  uiHandleLabel,
} from "./commit-gate.js";

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
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "act", input: { target: "Удалить для всех" } })?.what).toMatch(/Удалить/u);
  });
});

describe("assessGuiCommit + parseForegroundProcess", () => {
  const ctx = "Окна: 5 · На переднем плане: 1cv8 «Бухгалтерия предприятия» · Пользователь: за ПК";
  it("процесс из живого снимка парсится; Enter в 1С и вызов «Провести» — коммит; «Печать» — нет", () => {
    expect(parseForegroundProcess(ctx)).toBe("1cv8");
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "input_key", input: { combo: "enter" } })?.what).toMatch(/Enter/u);
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "ui_invoke", input: { handle: 7 }, label: "Button Провести и закрыть" })?.what).toMatch(/Провести/u);
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "ui_invoke", input: { handle: 7 }, label: "Button Печать" })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "input_key", input: { combo: "enter", mode: "up" } })).toBeNull();
  });
  it("Enter в Telegram Desktop — отправка сообщения; в Блокноте — ничего; координатный клик — ничего", () => {
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "input_key", input: { combo: "Enter" } })?.what).toMatch(/отправка сообщения/u);
    expect(assessGuiCommit({ foregroundProcess: "notepad", tool: "input_key", input: { combo: "enter" } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "Discord", tool: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "Discord", tool: "input_click", input: { target: { by: "text", text: "Отправить" } } })?.what).toMatch(/Отправить/u);
  });
  it("память handle→имя из ui_snapshot и последняя цель web_open", () => {
    const session = {};
    rememberUiHandles(session, { items: [{ handle: 11, role: "Button", name: "Провести" }, { handle: 12, role: "Edit", name: "" }] });
    expect(uiHandleLabel(session, 11)).toBe("Провести Button");
    expect(uiHandleLabel(session, 12)).toBe("Edit");
    expect(uiHandleLabel(session, 99)).toBeUndefined();
    rememberWebTarget(session, "https://www.ozon.ru/cart");
    expect(lastWebTarget(session)).toBe("https://www.ozon.ru/cart");
    expect(lastWebTarget({})).toBe("");
  });
});

describe("W4 act — тот же §14-гейт, что у input_key/input_click", () => {
  it("do:key Enter в мессенджере → коммит; do:key Ctrl+S → нет", () => {
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "act", input: { do: "key", combo: "Enter" } })?.what).toMatch(/отправка сообщения/u);
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "act", input: { do: "key", combo: "Ctrl+S" } })).toBeNull();
  });

  it("клик по «Провести»/«Отправить» (строка или {text}) → коммит; печать/set и клик по «Настройки»/в блокноте → нет", () => {
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "act", input: { target: "Провести" } })?.what).toMatch(/Провести/u);
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "act", input: { target: { text: "Отправить", role: "Button" }, do: "double" } })).not.toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "act", input: { target: "Отправить", do: "type", text: "x" } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "act", input: { target: "Настройки" } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "notepad", tool: "act", input: { target: "Отправить" } })).toBeNull();
  });

  // Ревью 2026-09-24 (контроль-1 №1): app — свободная строка модели; «дискорд»/«Telegram Desktop» окно находили,
  // а якорный регэксп процесса их не узнавал → Enter уходил человеку без вопроса.
  // Контроль-2: в почтовом клиенте перевод строки — абзац письма; «3ds Max»/«Zoom Player» — не мессенджеры.
  it("почта: многострочная печать без вопроса; «3ds Max»/«Zoom Player» не мессенджер, «Zoom» — да", () => {
    expect(assessGuiCommit({ foregroundProcess: "outlook", tool: "input_type", input: { text: "Добрый день,\nспасибо" } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "input_type", input: { text: "ок\n" } })).not.toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "chrome", app: "3ds Max", tool: "act", input: { do: "key", combo: "Enter" } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "chrome", app: "Zoom Player", tool: "act", input: { do: "key", combo: "Enter" } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "chrome", app: "Zoom", tool: "act", input: { do: "key", combo: "Enter" } })).not.toBeNull();
  });

  it("act{app} судится по имени из app нестрого: «дискорд», «Telegram Desktop», «телега» → коммит; «notepad» → нет", () => {
    for (const app of ["дискорд", "Telegram Desktop", "телега", "WhatsApp.exe", "1С:Предприятие"]) {
      expect(assessGuiCommit({ foregroundProcess: "chrome", app, tool: "act", input: { do: "key", combo: "Enter" } }), app).not.toBeNull();
    }
    expect(assessGuiCommit({ foregroundProcess: "Telegram", app: "notepad", tool: "act", input: { do: "key", combo: "Enter" } })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "chrome", app: "Блокнот", tool: "act", input: { target: "Отправить" } })).toBeNull();
  });
});
