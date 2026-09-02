/** §14 гейт необратимых кликов (причина №4 USER_SCENARIOS_2026-09-02) — чистые правила. */
import { describe, expect, it } from "vitest";
import {
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

describe("assessGuiCommit + parseForegroundProcess", () => {
  const ctx = "Окна: 5 · На переднем плане: 1cv8 «Бухгалтерия предприятия» · Пользователь: за ПК";
  it("процесс из живого снимка парсится; Enter в 1С и вызов «Провести» — коммит; «Печать» — нет", () => {
    expect(parseForegroundProcess(ctx)).toBe("1cv8");
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "input_key", input: { key: "enter" } })?.what).toMatch(/Enter/u);
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "ui_invoke", input: { handle: 7 }, label: "Button Провести и закрыть" })?.what).toMatch(/Провести/u);
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "ui_invoke", input: { handle: 7 }, label: "Button Печать" })).toBeNull();
    expect(assessGuiCommit({ foregroundProcess: "1cv8", tool: "input_key", input: { key: "enter", mode: "up" } })).toBeNull();
  });
  it("Enter в Telegram Desktop — отправка сообщения; в Блокноте — ничего; координатный клик — ничего", () => {
    expect(assessGuiCommit({ foregroundProcess: "Telegram", tool: "input_key", input: { key: "Enter" } })?.what).toMatch(/отправка сообщения/u);
    expect(assessGuiCommit({ foregroundProcess: "notepad", tool: "input_key", input: { key: "enter" } })).toBeNull();
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
