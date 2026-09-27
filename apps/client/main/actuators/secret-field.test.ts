/**
 * W2 П2 (§0): ПОЛЕ-СЕКРЕТ и АВТОВВОД — через НАСТОЯЩИЙ dispatch актуаторов и рубеж инжекции, сайдкар — фейк в реальной
 * форме (снапшот handle числом, value «•••» у IsPassword, read.screen «ControlType.Edit: Пароль [ЗАЩИЩЕНО]»).
 * Реверт-проверка (что сломать → какой кейс падает):
 *  • зеркало не читается (mirrorEntry → null)                 → «снапшот •••, setValue»;
 *  • признак поля только по памяти клика (без focused())      → «[ЗАЩИЩЕНО] без клика»;
 *  • память клика не пишется (noteInjected без click/invoke) → «клик по полю, read.screen лёг»;
 *  • §0 одобряем (судья смотрит c.scope.approval)             → «грант в области»;
 *  • autotype не судится / удержание не учитывается           → «Ctrl+Alt+A», «Ctrl↓ Alt↓ A».
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { selectionStore } from "../selection/store.js";
import { dispatch } from "./index.js";
import { serverExecutor } from "./approval-scope.js";
import { resetHeldKeys } from "./input.js";
import { resetMirror } from "./handle-mirror.js";
import { resetSecretMemory } from "./secret-memory.js";
import { resetFieldCache } from "./focused-field.js";

let fake: FakeSidecar;
let n = 0;
const run = (cmd: ActionCommand) => dispatch(`s${(n += 1)}`, cmd);
const ops = () => fake.mutations().map((c) => c.op);
const PASSWORD = { handle: 7, role: "edit", name: "", value: "•••", x: 100, y: 100, w: 200, h: 30 };
const LOGIN = { handle: 6, role: "edit", name: "Логин", value: "", x: 100, y: 50, w: 200, h: 30 };

const prevObserve = process.env.JARVIS_FUSED_OBSERVE;
beforeAll(() => {
  process.env.JARVIS_FUSED_OBSERVE = "0"; // наблюдение после действия к рубежу не относится — без пауз стабилизации
});
afterAll(() => {
  if (prevObserve === undefined) delete process.env.JARVIS_FUSED_OBSERVE;
  else process.env.JARVIS_FUSED_OBSERVE = prevObserve;
});

beforeEach(() => {
  fake = useFakeSidecar();
  fake.snapshot = { window: "Вход — Банк", pid: 700, items: [LOGIN, PASSWORD], truncated: false };
  fake.windows = [{ hwnd: 70, pid: 700, process: "bank", title: "Вход — Банк", foreground: true, x: 0, y: 0, w: 800, h: 600 }];
  resetElectronMock();
  resetHeldKeys();
  resetMirror();
  resetSecretMemory();
  resetFieldCache();
  selectionStore.setDrawing(false);
});

describe("поле-секрет по зеркалу handle (setValue)", () => {
  it("снапшот: Edit со значением «•••» (IsPassword, имя пустое) → setValue 7 — denied, invoke не ушёл", async () => {
    expect((await run({ kind: "ui.snapshot" })).ok).toBe(true);
    const r = await run({ kind: "ui.invoke", target: { by: "handle", handle: "7" }, pattern: "setValue", value: "hunter2" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/§0/u);
    expect(r.data).toEqual({ secretGuard: "field" }); // без needsApproval: вопроса владельцу не будет
    expect(ops()).toEqual([]);
  });

  it("подсказка поля в имени/automationId (без маски) — тоже секрет; обычное поле «Логин» — setValue уходит", async () => {
    fake.snapshot.items = [LOGIN, { ...PASSWORD, value: null, name: "Код из СМС" }, { handle: 8, role: "edit", name: "", automationId: "txtPassword", x: 0, y: 0, w: 1, h: 1 }];
    await run({ kind: "ui.snapshot" });
    expect((await run({ kind: "ui.invoke", target: { by: "handle", handle: "7" }, pattern: "setValue", value: "1234" })).error?.code).toBe("denied");
    expect((await run({ kind: "ui.invoke", target: { by: "handle", handle: "8" }, pattern: "setValue", value: "x" })).error?.code).toBe("denied");
    expect((await run({ kind: "ui.invoke", target: { by: "handle", handle: "6" }, pattern: "setValue", value: "ivan" })).ok).toBe(true);
    expect(ops()).toEqual(["invoke"]);
  });

  it("карта в setValue — denied в любом поле", async () => {
    await run({ kind: "ui.snapshot" });
    const r = await run({ kind: "ui.invoke", target: { by: "handle", handle: "6" }, pattern: "setValue", value: "4276 1600 1234 5675" });
    expect(r.data).toEqual({ secretGuard: "card" });
    expect(ops()).toEqual([]);
  });
});

describe("поле в фокусе (read.screen) и память клика", () => {
  it("read.screen «Edit: Пароль [ЗАЩИЩЕНО]» → type БЕЗ предшествующего клика — denied, ноль type", async () => {
    fake.focusedText = "ControlType.Edit: Пароль [ЗАЩИЩЕНО]\nControlType.Button: Войти";
    const r = await run({ kind: "input.type", text: "hunter2" });
    expect(r.error?.code).toBe("denied");
    expect(r.data).toEqual({ secretGuard: "field" });
    expect(ops()).toEqual([]);
  });

  it("подсказка в имени поля в фокусе («Код из СМС [ПУСТО]») — denied; кнопка «Забыли пароль?» в фокусе — не поле, печать идёт", async () => {
    fake.focusedText = "ControlType.Edit: Код из СМС [ПУСТО]";
    expect((await run({ kind: "input.type", text: "1234" })).error?.code).toBe("denied");
    fake.focusedText = "ControlType.Button: Забыли пароль?";
    expect((await run({ kind: "input.type", text: "привет" })).ok).toBe(true);
    expect(ops()).toEqual(["type"]);
  });

  it("клик по полю «•••» (handle 7) → input.type при ЛЁГШЕМ read.screen (таймаут UIA) — denied по памяти клика", async () => {
    fake.handlers["read.screen"] = () => {
      throw new Error("UIA timeout");
    };
    await run({ kind: "ui.snapshot" });
    expect((await run({ kind: "input.click", target: { by: "handle", handle: "7" } })).ok).toBe(true);
    const r = await run({ kind: "input.type", text: "x" });
    expect(r.error?.code).toBe("denied");
    expect(r.error?.message).toMatch(/клик/u);
    expect(ops()).toEqual(["invoke"]); // клик ушёл (UIA invoke), печать — нет
  });

  it("read.screen лёг, клик по обычному полю — печать идёт (fail-open только по полю), а карта — нет (Луна всегда)", async () => {
    fake.handlers["read.screen"] = () => {
      throw new Error("UIA timeout");
    };
    await run({ kind: "ui.snapshot" });
    await run({ kind: "input.click", target: { by: "handle", handle: "6" } });
    expect((await run({ kind: "input.type", text: "ivan" })).ok).toBe(true);
    expect((await run({ kind: "input.type", text: " 4276 1600 1234 5675" })).data).toEqual({ secretGuard: "card" });
    expect(ops()).toEqual(["invoke", "type"]);
  });

  it("память клика — только пока фокус в той же программе: передний план сменился (другой pid) → печать идёт", async () => {
    await run({ kind: "ui.snapshot" });
    await run({ kind: "input.click", target: { by: "handle", handle: "7" } });
    fake.windows = [{ hwnd: 90, pid: 900, process: "notepad", title: "Блокнот", foreground: true, x: 0, y: 0, w: 800, h: 600 }];
    expect((await run({ kind: "input.type", text: "заметка" })).ok).toBe(true);
  });

  it("память клика сбрасывается клавишей, уводящей из поля (Tab), но не правкой внутри поля (End)", async () => {
    fake.focusedText = "";
    await run({ kind: "ui.snapshot" });
    await run({ kind: "input.click", target: { by: "handle", handle: "7" } });
    await run({ kind: "input.key", combo: "End" });
    expect((await run({ kind: "input.type", text: "x" })).error?.code).toBe("denied");
    await run({ kind: "input.key", combo: "Tab" });
    expect((await run({ kind: "input.type", text: "x" })).ok).toBe(true);
  });

  it("печатные клавиши по одной в поле-пароль после клика — denied (память клика без read.screen)", async () => {
    await run({ kind: "ui.snapshot" });
    await run({ kind: "input.click", target: { by: "handle", handle: "7" } });
    const r = await run({ kind: "input.key", combo: "h" });
    expect(r.error?.code).toBe("denied");
    expect(fake.count("read.screen")).toBe(0); // клавиша — без UIA-вызова на каждое нажатие
    expect(ops()).toEqual(["invoke"]);
  });
});

describe("§0 неодобряем; автоввод", () => {
  it("грант в области серверной команды + печать в поле-секрет — всё равно denied, без needsApproval", async () => {
    fake.focusedText = "ControlType.Edit: Пароль [ЗАЩИЩЕНО]";
    const approval = { grants: [{ signature: "key:enter", process: "bank", count: 5 }], expiresAt: Date.now() + 60_000 };
    const r = await serverExecutor(dispatch)("g1", { kind: "input.type", text: "hunter2", approval });
    expect(r.error?.code).toBe("denied");
    expect(r.data).toEqual({ secretGuard: "field" });
    expect(ops()).toEqual([]);
  });

  it.each(["Ctrl+Alt+A", "Ctrl+Shift+L", "Ctrl+\\", "alt+ctrl+a"])("автоввод менеджера паролей «%s» — denied всегда", async (combo) => {
    const r = await run({ kind: "input.key", combo });
    expect(r.error?.code).toBe("denied");
    expect(r.data).toEqual({ secretGuard: "autotype" });
    expect(ops()).toEqual([]);
  });

  it("автоввод, собранный УДЕРЖАНИЕМ: Ctrl↓, Alt↓, затем «A» — denied на «A»", async () => {
    expect((await run({ kind: "input.key", combo: "Ctrl", mode: "down" })).ok).toBe(true);
    expect((await run({ kind: "input.key", combo: "Alt", mode: "down" })).ok).toBe(true);
    const r = await run({ kind: "input.key", combo: "a" });
    expect(r.data).toEqual({ secretGuard: "autotype" });
    expect(fake.mutations().map((c) => c.args.combo)).toEqual(["Ctrl", "Alt"]);
  });

  it("Win+V (история буфера обмена) — отказ, ни одного нажатия", async () => {
    const r = await run({ kind: "input.key", combo: "Win+V" });
    expect(r.ok).toBe(false);
    expect(ops()).toEqual([]);
  });
});
