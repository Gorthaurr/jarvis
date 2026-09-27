/**
 * W4 «Руки»: примитив act — ОРКЕСТРАТОР (окно app → поиск → снимок «до» → рубеж → действие → сверка). Тесты идут через
 * РЕАЛЬНЫЙ act(); мокаются только листья (test-support/act-mocks). W2 (пакет 0): поиск — act-find.test.ts (П5),
 * действие — act-do.test.ts (П4), здесь — оркестрация (П1).
 *
 * Что охраняется (каждый кейс — реверт-проверяемый):
 *  - окно app не найдено → ошибка ДО поиска и действия; фокус — факт в ответе (заголовок);
 *  - «не смог проверить» ≠ «не наступило» (unknown → unchecked, не failed); признак, видимый ДО действия, — unchecked;
 *  - §14-рубеж act стоит ДО действия (контроль-2 №4);
 *  - W2: observe:false — ни снимка «до», ни наблюдения «после»; hwnd окна app доходит до поиска.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = await vi.hoisted(async () => (await import("../test-support/act-mocks.js")).createActState());
vi.mock("./ground.js", async () => (await import("../test-support/act-mocks.js")).actMocks.ground(st));
vi.mock("./screen.js", async () => (await import("../test-support/act-mocks.js")).actMocks.screen());
vi.mock("./sensors-cheap.js", async () => (await import("../test-support/act-mocks.js")).actMocks.sensors(st));
vi.mock("./input.js", async () => (await import("../test-support/act-mocks.js")).actMocks.input(st));
vi.mock("./paste-text.js", async () => (await import("../test-support/act-mocks.js")).actMocks.paste(st));
vi.mock("./observe.js", async () => (await import("../test-support/act-mocks.js")).actMocks.observe(st));
vi.mock("./windows.js", async () => (await import("../test-support/act-mocks.js")).actMocks.windows(st));
vi.mock("./apps.js", async () => (await import("../test-support/act-mocks.js")).actMocks.apps(st));

import { resetActState } from "../test-support/act-mocks.js";
import { act } from "./act.js";
import { verifyCondition } from "./act-verify.js";

const OPTS = { restoreCursor: true };
beforeEach(() => resetActState(st));

describe("act — окно app", () => {
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
});

describe("act — сверка", () => {
  it("сенсор не смог проверить (unknown) → verified:unchecked, не failed", async () => {
    st.wait = async () => ({ met: false, unknown: true, elapsedMs: 1, polls: 0, detail: "сайдкар не ответил" });
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Отправлено" } }, OPTS);
    expect(r.verified).toBe("unchecked");
    expect(r.detail).toMatch(/не смог проверить/u);
  });

  it("H-V1: признак был виден ещё ДО действия → итог unchecked, а не «подтверждено»", async () => {
    st.wait = async () => ({ met: true, elapsedMs: 50, polls: 1, detail: "видно «Настройки»" });
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Настройки" } }, OPTS);
    expect(r.verified).toBe("unchecked");
    expect(r.detail).toMatch(/ДО действия/);
  });

  it("W2 observe:false — ни снимка «до», ни наблюдения «после»; признак verify всё равно ждём", async () => {
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Отправлено" }, observe: false }, OPTS);
    expect(st.captureCalls).toBe(0);
    expect(st.observeCalls).toBe(0);
    expect(r.observation).toBeUndefined();
    expect(r.verified).toBe("met");
    await act({ kind: "gui.act", target: "Отправить" }, OPTS);
    expect(st.captureCalls).toBe(1);
    expect(st.observeCalls).toBe(1);
  });

  it("verifyCondition: text → wait text; element → ui substring; title → window; gone пробрасывается; пусто → null", () => {
    expect(verifyCondition({ text: " Отправлено " })).toEqual({ kind: "text", text: "Отправлено", monitor: "active", gone: false });
    expect(verifyCondition({ element: { role: "Window", name: "Сохранить" }, gone: true })).toEqual({ kind: "ui", role: "Window", name: "Сохранить", nameMode: "substring", gone: true });
    expect(verifyCondition({ title: "Блокнот" })).toEqual({ kind: "window", titleContains: "Блокнот", gone: false });
    expect(verifyCondition({ timeoutMs: 3000 })).toBeNull();
  });
});

describe("act — §14 до действия", () => {
  // Контроль-2 №4: проводка рубежа в самом act. Реверт: убери вызов assertActCommitAllowed в act.ts — Enter нажмётся.
  it("app «tele» сфокусировал Telegram, Enter без подтверждения сервера → отказ ДО нажатия; с подтверждением — нажимает", async () => {
    st.fg = "Telegram";
    await expect(act({ kind: "gui.act", app: "tele", do: "key", combo: "Enter" }, OPTS)).rejects.toThrow(/§14.*Ничего не нажато/u);
    expect(st.pressKey).not.toHaveBeenCalled();
    await act({ kind: "gui.act", app: "Telegram", do: "key", combo: "Enter", commitApproved: true }, OPTS);
    expect(st.pressKey).toHaveBeenCalledWith("Enter");
  });
});
