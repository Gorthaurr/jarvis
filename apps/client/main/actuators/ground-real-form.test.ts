/**
 * W2 (пакет 0): грундинг на РЕАЛЬНОЙ форме ответа сайдкара (Ipc.cs GroundResult — плоский bbox + name + role).
 *
 * Дефект, найденный фикстурой в реальной форме: разбор читал только вложенный `bbox`, а сайдкар отдаёт x/y/w/h плоско —
 * bbox всегда был нулевым, и проверка «под точкой контейнер» (H-A1) в бою не срабатывала: act по точке жал invoke
 * по handle контейнера (клик в ЕГО центр) с отчётом «нажал». Реверт: вернуть `const b = d.bbox;` в ground.ts.
 * Плюс зеркало handle: наполняется из снапшота и ground.at, живёт в своём поколении сайдкара.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
vi.mock("./observe.js", () => ({ captureUiFingerprint: async () => undefined, observeAfterAction: async () => undefined }));

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { groundAtPoint, uiSnapshot } from "./ground.js";
import { mirrorOf, resetMirror } from "./handle-mirror.js";
import { act } from "./act.js";

let fake: FakeSidecar;
beforeEach(() => {
  fake = useFakeSidecar();
  // W2 П1: рубеж инжекции судит процесс под точкой — Блокнот на весь экран (не рискованный).
  fake.windows = [{ hwnd: 5, pid: 4242, process: "notepad", title: "Блокнот", foreground: true, x: 0, y: 0, w: 1920, h: 1080 }];
  resetElectronMock();
  resetMirror();
});

describe("ground.at — реальная форма", () => {
  it("плоский bbox, имя и роль доходят до GroundResult", async () => {
    fake.at = () => ({ handle: 41, role: "button", name: "Отправить", x: 100, y: 200, w: 90, h: 32 });
    const g = await groundAtPoint(120, 210);
    expect(g).toEqual({ handle: "41", bbox: { x: 100, y: 200, w: 90, h: 32 }, name: "Отправить", role: "ControlType.Button" });
  });

  it("H-A1 в бою: под точкой контейнер 1343×756 → физический клик В ТОЧКУ, не invoke по handle контейнера", async () => {
    fake.at = () => ({ handle: 99, role: "group", name: "", x: 0, y: 0, w: 1343, h: 756 });
    const r = await act({ kind: "gui.act", target: { x: 500, y: 400, space: "screen" } }, { restoreCursor: true });
    expect(fake.count("invoke")).toBe(0);
    expect(fake.mutations()).toEqual([{ op: "click", args: { x: 500, y: 400, restoreCursor: true, button: "left", count: 1 } }]);
    expect(r.found?.note ?? "").toMatch(/контейнер 1343×756/u);
  });

  it("малый элемент под точкой → бесшумный invoke по его handle, в ответе — РЕАЛЬНОЕ имя и запрос отдельно", async () => {
    fake.at = () => ({ handle: 41, role: "button", name: "Отправить", x: 480, y: 390, w: 90, h: 32 });
    const r = await act({ kind: "gui.act", target: { x: 500, y: 400, space: "screen", text: "стрелка" } }, { restoreCursor: true });
    expect(fake.mutations().map((c) => [c.op, c.args.handle])).toEqual([["invoke", "41"]]);
    expect(r.found).toMatchObject({ via: "point", name: "Отправить", query: "стрелка", role: "Button", handle: "41" });
  });
});

describe("зеркало handle", () => {
  it("снапшот (handle числом, роль короткая) и ground.at наполняют зеркало; чужое поколение — null", async () => {
    fake.snapshot = { window: "Telegram", pid: 7, items: [{ handle: 41, role: "button", name: "Отправить", x: 1, y: 2, w: 3, h: 4, value: null }], truncated: false };
    await uiSnapshot();
    expect(mirrorOf("41", 1)).toMatchObject({ name: "Отправить", role: "button", pid: 7, bbox: { x: 1, y: 2, w: 3, h: 4 }, gen: 1 });
    expect(mirrorOf(41, 2)).toBeNull(); // сайдкар перезапущен — handle 41 уже чужой
    fake.at = () => ({ handle: 55, role: "edit", name: "Пароль", x: 0, y: 0, w: 10, h: 10 });
    await groundAtPoint(5, 5);
    expect(mirrorOf("55", 1)).toMatchObject({ name: "Пароль", role: "ControlType.Edit" });
  });
});
