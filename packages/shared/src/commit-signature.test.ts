/** W2: подпись коммита, канон процесса, поиск гранта; категории процессов рубежа (commit-risk W2). */
import { describe, expect, it } from "vitest";
import { canonicalProcess, commitSignature, findGrant, foldLabel, normRole, textIntents } from "./commit-signature.js";
import { guiProcessCategory, riskyAppCategory, riskyProcessCategory } from "./commit-risk.js";

describe("foldLabel / commitSignature", () => {
  it("регистр, ё, кавычки, невидимые символы и пробелы не меняют подпись", () => {
    expect(foldLabel(" «Отправить» ")).toBe("отправить");
    expect(foldLabel("Отправи​ть")).toBe("отправить");
    expect(foldLabel("Сохранённое   сообщение")).toBe("сохраненное сообщение");
    expect(commitSignature({ name: "  Отправить ", role: "ControlType.Button" })).toBe("click:отправить");
  });

  it("безымянный элемент — по роли без префикса; клавиша — канон комбо", () => {
    expect(commitSignature({ name: "", role: "ControlType.Button" })).toBe("click:?button");
    expect(commitSignature({ role: "" })).toBe("click:?element");
    expect(commitSignature({ combo: "Enter+Ctrl" })).toBe("key:ctrl+enter");
    expect(normRole("ControlType.ListItem")).toBe("listitem");
  });
});

describe("canonicalProcess", () => {
  it.each([
    ["Telegram", "telegram"],
    ["Telegram.exe", "telegram"],
    ["телега", "telegram"],
    ["Telegram Desktop", "telegram"],
    ["1cv8c", "1cv8"],
    ["1С", "1cv8"],
    ["ms-teams", "teams"],
    ["olk", "outlook"],
    ["HxOutlook", "outlook"],
    ["mstsc", "mstsc"],
    ["chrome", "chrome"],
  ])("%s → %s", (raw, canon) => {
    expect(canonicalProcess(raw)).toBe(canon);
  });

  it("незнакомое или неоднозначное → null (сервер заранее не спрашивает; спросит клиент по реальному процессу)", () => {
    expect(canonicalProcess("Катя")).toBeNull();
    expect(canonicalProcess("notepad")).toBeNull();
    expect(canonicalProcess("3ds Max")).toBeNull();
    expect(canonicalProcess("")).toBeNull();
  });
});

describe("findGrant", () => {
  const grants = [
    { signature: "click:отправить", process: "telegram", count: 1 },
    { signature: "key:enter", process: "telegram", hwnd: 7, count: 1 },
    { signature: "key:enter", process: "discord", count: 0 },
  ];
  it("подпись + процесс + окно + остаток", () => {
    expect(findGrant(grants, { signature: "click:отправить", process: "telegram" })).toBe(grants[0]);
    expect(findGrant(grants, { signature: "click:отправить", process: "discord" })).toBeNull();
    expect(findGrant(grants, { signature: "key:enter", process: "telegram", hwnd: 7 })).toBe(grants[1]);
    expect(findGrant(grants, { signature: "key:enter", process: "telegram", hwnd: 8 })).toBeNull();
    expect(findGrant(grants, { signature: "key:enter", process: "telegram" })).toBeNull(); // окно неизвестно — не наше
    expect(findGrant(grants, { signature: "key:enter", process: "discord" })).toBeNull(); // исчерпан
    expect(findGrant(grants, { signature: "click:отправить", process: null })).toBeNull();
    expect(findGrant(undefined, { signature: "x", process: "telegram" })).toBeNull();
  });
});

describe("textIntents", () => {
  it("\\n и \\r\\n — по одному Enter, \\t — Tab", () => {
    expect(textIntents("a\nb\r\nc\td")).toEqual({ newlines: 2, tabs: 1 });
    expect(textIntents("")).toEqual({ newlines: 0, tabs: 0 });
  });
});

describe("commit-risk W2: процессы рубежа", () => {
  it("новые мессенджеры и почта рискованны", () => {
    for (const p of ["ms-teams", "signal", "Skype", "element", "vkteams", "VK Teams"]) expect(riskyProcessCategory(p)?.category, p).toBe("messenger");
    for (const p of ["olk", "HxOutlook"]) expect(riskyProcessCategory(p)?.human, p).toBe("почта");
    expect(riskyAppCategory("Photoshop Elements")).toBeNull();
  });

  it("guiProcessCategory: удалённый доступ → remote, браузер → web, ApplicationFrameHost/неизвестный → по заголовку", () => {
    expect(guiProcessCategory("mstsc")?.category).toBe("remote");
    expect(guiProcessCategory("vmware-vmx")?.category).toBe("remote");
    expect(guiProcessCategory("AnyDesk")?.category).toBe("remote");
    expect(guiProcessCategory("msedge")?.category).toBe("web");
    expect(guiProcessCategory("browser")?.category).toBe("web");
    expect(guiProcessCategory("ApplicationFrameHost", "Outlook — Входящие")?.category).toBe("messenger");
    expect(guiProcessCategory("ApplicationFrameHost", "Калькулятор")).toBeNull();
    expect(guiProcessCategory(null, "Telegram")?.category).toBe("messenger");
    expect(guiProcessCategory("notepad", "Telegram — заметки.txt")).toBeNull(); // известный процесс судится по нему
    expect(guiProcessCategory("Telegram")?.category).toBe("messenger");
  });
});
