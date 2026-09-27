/**
 * W4 «Руки»: примитив act — ОРКЕСТРАТОР (окно app → поиск → ранняя проверка клавиш → снимок «до» → действие → сверка).
 * Тесты идут через РЕАЛЬНЫЙ act() и НАСТОЯЩИЙ рубеж инжекции (судьи, факты на fake-sidecar в реальной форме); мокаются
 * только листья act (test-support/act-mocks). W2: поиск — act-find.test.ts (П5), действие — act-do.test.ts (П4).
 *
 * Что охраняется (каждый кейс — реверт-проверяемый):
 *  - окно app не найдено → ошибка ДО поиска и действия; фокус — факт в ответе (заголовок);
 *  - «не смог проверить» ≠ «не наступило» (unknown → unchecked, не failed); признак, видимый ДО действия, — unchecked;
 *  - W2 П1 (G-9): клавишное намерение (combo, «\n» в тексте) судится ДО первой инжекции (клика в поле); одобрение —
 *    только грант из области серверной команды (прежний `commitApproved` удалён из протокола и ничего не значит);
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
// W2 П1: рубеж инжекции — настоящий; его факты (окна, фокус) — фейковый сайдкар в реальной форме и мок Electron.
vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { resetActState } from "../test-support/act-mocks.js";
import { act } from "./act.js";
import { verifyCondition } from "./act-verify.js";
import { serverExecutor } from "./approval-scope.js";

const OPTS = { restoreCursor: true };
const TG = { hwnd: 1, pid: 7, process: "Telegram", title: "Telegram", foreground: true, x: 0, y: 0, w: 1920, h: 1080 };
let fake: FakeSidecar;
beforeEach(() => {
  resetActState(st);
  resetElectronMock();
  fake = useFakeSidecar();
  fake.windows = [TG];
  fake.focusedText = "ControlType.Edit: Сообщение";
});

describe("act — окно app", () => {
  it("app не найдено (сайдкар и AppActivate не сфокусировали) → ошибка ДО поиска и действия", async () => {
    st.focusWindow = async () => ({ focused: false, hwnd: 0, title: "" });
    await expect(act({ kind: "gui.act", app: "Telegram", target: "Отправить" }, OPTS)).rejects.toThrow(/окно «Telegram» не найдено.*ничего не нажато/u);
    expect(st.snapshotCalls).toBe(0);
    expect(st.invoke).not.toHaveBeenCalled();
  });

  it("app сфокусировано → ответ несёт focused; do:key → pressKey без цели; do:key без combo → ошибка", async () => {
    fake.windows = [{ ...TG, process: "notepad", title: "Блокнот" }];
    st.focusWindow = async () => ({ focused: true, hwnd: 1, title: "Блокнот" });
    const r = await act({ kind: "gui.act", app: "Блокнот", do: "key", combo: "Ctrl+S" }, OPTS);
    expect(r.focused).toBe("Блокнот");
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

describe("act — §14 до действия (W2 П1, G-9: ранняя проверка клавиш)", () => {
  const approve = (grants: Array<{ signature: string; process: string; count: number; hwnd?: number }>, run: () => Promise<unknown>) =>
    serverExecutor(async (commandId) => (await run(), { commandId, ok: true, durationMs: 0 }))("srv-1", { kind: "gui.act", approval: { grants, expiresAt: Date.now() + 60_000 } });

  // Реверт: убери earlyKeyCheck в act.ts — Enter дойдёт до pressKey (листа), рубеж его уже не увидит.
  it("app «tele» сфокусировал Telegram, Enter без гранта → отказ ДО нажатия; прежний `commitApproved` в теле не одобряет; грант key:enter — нажимает", async () => {
    await expect(act({ kind: "gui.act", app: "tele", do: "key", combo: "Enter" }, OPTS)).rejects.toMatchObject({ actionCode: "denied" });
    const legacy = { kind: "gui.act", app: "tele", do: "key", combo: "Enter", commitApproved: true } as Parameters<typeof act>[0]; // поле удалено из протокола
    await expect(act(legacy, OPTS)).rejects.toThrow(/§14.*Ничего не нажато/u);
    expect(st.pressKey).not.toHaveBeenCalled();
    await approve([{ signature: "key:enter", process: "telegram", count: 1 }], () => act({ kind: "gui.act", app: "Telegram", do: "key", combo: "Enter" }, OPTS));
    expect(st.pressKey).toHaveBeenCalledWith("Enter");
  });

  it("«привет\n» в поле Telegram без гранта → отказ ДО клика в поле: ни клика, ни печати; needsApproval — key:enter", async () => {
    let err: unknown;
    await approve([], () => act({ kind: "gui.act", app: "Telegram", do: "type", target: "Поиск", text: "привет\n" }, OPTS)).catch((e) => (err = e));
    expect(err).toMatchObject({ actionCode: "denied", actionData: { needsApproval: { signature: "key:enter", process: "telegram", category: "messenger" } } });
    expect(st.click).not.toHaveBeenCalled();
    expect(st.typeText).not.toHaveBeenCalled();
  });

  it("G-11: act сфокусировал Блокнот (hwnd 11), а спереди уже Telegram → клавиша не уходит: «фокус ушёл», ничего не нажато", async () => {
    fake.windows = [TG, { ...TG, hwnd: 11, pid: 9, process: "notepad", title: "Блокнот", foreground: false }];
    st.focusWindow = async () => ({ focused: true, hwnd: 11, title: "Блокнот" });
    await expect(act({ kind: "gui.act", app: "Блокнот", do: "key", combo: "Ctrl+S" }, OPTS)).rejects.toThrow(/фокус ушёл с «Блокнот» на «Telegram»/u);
    expect(st.pressKey).not.toHaveBeenCalled();
  });
});
