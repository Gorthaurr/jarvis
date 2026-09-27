/**
 * W2 (П4, G-20): app.launch ждёт окно запущенного. Последовательности window.list — в реальной форме сайдкара
 * (z-порядок сверху вниз, hwnd/pid/process/foreground). Проводка — через НАСТОЯЩИЙ dispatch клиента (app.launch →
 * launchApp → withLaunchWindow), подменён только лаунчер ОС (PowerShell на Linux не запустить).
 * Реверт-проверка: убери поиск «стало передним / новое» в pickLaunchWindow — падает «лаунчер с другим pid»;
 * верни windowSeen:false без ответа сайдкара — падает «сайдкар молчит».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSidecar, FakeWindow } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
const launched = vi.hoisted(() => ({ pid: 5000 as number | undefined, calls: [] as string[] }));
vi.mock("./app-resolve.js", async (orig) => ({
  ...(await orig<typeof import("./app-resolve.js")>()),
  smartLaunch: async (t: string) => {
    launched.calls.push(t);
    return { resolved: t, pid: launched.pid, kind: "exe", source: "PATH", verified: "process" };
  },
}));

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { selectionStore } from "../selection/store.js";
import { withLaunchWindow } from "./launch-window.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
const win = (hwnd: number, pid: number, process: string, title: string, foreground = false): FakeWindow => ({ hwnd, pid, process, title, foreground, x: 0, y: 0, w: 800, h: 600 });
const EXPLORER = win(10, 100, "explorer", "Проводник", true);

/** window.list по очереди: первый ответ — снимок ДО запуска, дальше — опросы (последний повторяется). */
function listSequence(...frames: FakeWindow[][]): void {
  let i = 0;
  fake.handlers["window.list"] = () => ({ windows: frames[Math.min(i++, frames.length - 1)] });
}

beforeEach(() => {
  fake = useFakeSidecar();
  resetElectronMock();
  selectionStore.setDrawing(false);
  launched.pid = 5000;
  launched.calls = [];
});

describe("ожидание окна после запуска (G-20)", () => {
  it("окно процесса запуска появилось на 3-м опросе → window{hwnd,title}", async () => {
    listSequence([EXPLORER], [EXPLORER], [EXPLORER], [win(77, 5000, "notepad", "Безымянный — Блокнот", true), EXPLORER]);
    const r = await withLaunchWindow("notepad", async () => ({ pid: 5000 }), 3_000);
    expect(r).toEqual({ pid: 5000, window: { hwnd: 77, title: "Безымянный — Блокнот" } });
  });

  it("лаунчер с ДРУГИМ pid (UWP: окно у ApplicationFrameHost) — новое переднее окно чужого pid тоже окно запуска", async () => {
    listSequence([EXPLORER], [win(88, 6123, "ApplicationFrameHost", "Параметры", true), { ...EXPLORER, foreground: false }]);
    const r = await withLaunchWindow("ms-settings:", async () => ({ pid: undefined }), 3_000);
    expect(r.window).toEqual({ hwnd: 88, title: "Параметры" });
  });

  it("уже запущенная копия вышла вперёд (окно было и до запуска) → её окно", async () => {
    const tg = win(55, 700, "Telegram", "Telegram", false);
    listSequence([EXPLORER, tg], [{ ...tg, foreground: true }, { ...EXPLORER, foreground: false }]);
    const r = await withLaunchWindow("telegram", async () => ({ pid: 5000 }), 3_000);
    expect(r.window).toEqual({ hwnd: 55, title: "Telegram" });
  });

  it("за время ожидания окна нет → windowSeen:false (не «запустил и готово»)", async () => {
    listSequence([EXPLORER], [EXPLORER]);
    const r = await withLaunchWindow("steam", async () => ({ pid: 5000 }), 400);
    expect(r.windowSeen).toBe(false);
    expect(r.window).toBeUndefined();
  });

  it("сайдкар не готов → окно не ждём и ничего не утверждаем", async () => {
    fake.ready = false;
    const r = await withLaunchWindow("notepad", async () => ({ pid: 5000 }), 300);
    expect(r).toEqual({ pid: 5000 });
  });

  it("сайдкар ответил до запуска, а потом молчит (таймауты) → «не видно окна» НЕ утверждаем", async () => {
    let n = 0;
    fake.handlers["window.list"] = () => {
      if (n++ === 0) return { windows: [EXPLORER] };
      throw new Error("sidecar timeout op=window.list");
    };
    const r = await withLaunchWindow("notepad", async () => ({ pid: 5000 }), 400);
    expect(r).toEqual({ pid: 5000 });
  });

  it("веб-адрес (фолбэк browser.open) окна не ждёт — window.list не опрашивается", async () => {
    listSequence([EXPLORER]);
    await withLaunchWindow("https://ya.ru", async () => ({}), 3_000);
    expect(fake.count("window.list")).toBe(0);
  });

  it("проводка: dispatch app.launch → данные результата несут окно запуска", async () => {
    listSequence([EXPLORER], [win(91, 5000, "notepad", "Блокнот", true), EXPLORER]);
    const r = await dispatch("c1", { kind: "app.launch", app: "notepad", origin: "user" });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ window: { hwnd: 91, title: "Блокнот" } });
    expect(launched.calls).toHaveLength(1);
  });
});
