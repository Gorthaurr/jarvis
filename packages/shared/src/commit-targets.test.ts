/** W2: коммит по элементу — allowlist безопасных целей в messenger/bank/edo, глаголы — в прочих категориях. */
import { describe, expect, it } from "vitest";
import { elementCommit } from "./commit-targets.js";

const el = (role: string, name: string) => ({ role, name });

describe("elementCommit — messenger/bank/edo (allowlist)", () => {
  it.each([
    [el("ControlType.Edit", "Сообщение"), null],
    [el("document", ""), null],
    [el("tabitem", "Чаты"), null],
    [el("treeitem", "Папка"), null],
    [el("scrollbar", ""), null],
    [el("listitem", "Катя"), null],
    [el("button", "Назад"), null],
    [el("button", "Поиск"), null],
    [el("menuitem", "Настройки"), null],
    [el("button", "Close"), null],
    // То, что денилист глаголов не узнавал.
    [el("button", "Отпр"), "click:отпр"],
    [el("button", "➤"), "click:➤"],
    [el("button", "×"), "click:×"],
    [el("button", ""), "click:?button"],
    [el("listitem", "😀"), "click:😀"],
    [el("listitem", ""), "click:?listitem"],
    [el("button", "Прикрепить"), "click:прикрепить"],
    [el("button", " Отправить "), "click:отправить"],
  ])("%o → %s", (e, sig) => {
    expect(elementCommit(e, "messenger", "click")).toBe(sig);
  });

  it("глаголы-нажатия судятся одинаково; правый клик, hover, set — не коммит", () => {
    for (const v of ["click", "invoke", "double", "triple", "middle", "drag", "down"]) expect(elementCommit(el("button", "Отпр"), "bank", v), v).toBe("click:отпр");
    for (const v of ["right", "hover", "scroll", "set", "expand", "type"]) expect(elementCommit(el("button", "Отпр"), "messenger", v), v).toBeNull();
  });

  it("select/toggle — по расширенным словам; да/ок — только в bank и edo", () => {
    expect(elementCommit(el("checkbox", "Переслать"), "messenger", "toggle")).toBe("click:переслать");
    expect(elementCommit(el("radiobutton", "Share"), "messenger", "select")).toBe("click:share");
    expect(elementCommit(el("checkbox", "Звук"), "messenger", "toggle")).toBeNull();
    expect(elementCommit(el("radiobutton", "Да"), "bank", "select")).toBe("click:да");
    expect(elementCommit(el("radiobutton", "Да"), "edo", "select")).toBe("click:да");
    expect(elementCommit(el("radiobutton", "Да"), "messenger", "select")).toBeNull();
  });
});

describe("elementCommit — прочие категории (глаголы) и нерискованные", () => {
  it("web/market/social: только COMMIT_WORDS_RE", () => {
    expect(elementCommit(el("button", "Оплатить"), "web", "click")).toBe("click:оплатить");
    expect(elementCommit(el("hyperlink", "Новости"), "web", "click")).toBeNull();
    expect(elementCommit(el("button", "Отпр"), "market", "click")).toBeNull();
    expect(elementCommit(el("button", ""), "web", "click")).toBeNull();
  });

  it("remote и нерискованный процесс — элементы не судятся", () => {
    expect(elementCommit(el("button", "Отправить"), "remote", "click")).toBeNull();
    expect(elementCommit(el("button", "Отправить"), null, "click")).toBeNull();
  });
});
