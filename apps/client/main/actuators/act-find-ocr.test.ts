/**
 * W2 П5 (G-12): OCR-ступень поиска цели act — В ОКНЕ app (или переднем), а не по всему экрану; строки под окном самого
 * Джарвиса и под перекрывающим чужим окном целью не становятся. Настоящие act-find / act-find-ocr / windows / ground /
 * screen-ocr / screen-grab; фейки — сайдкар в реальной форме (window.list в z-порядке с pid/hwnd, физический rect) и
 * desktopCapturer, чей OCR «видит» слова в физических пикселях монитора.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { type Prov, type ScreenWord, ocrSees, provOf, resetCapturer } from "../test-support/fake-capturer.js";
import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { ActFindError, findTarget } from "./act-find.js";
import { _resetFramesForTest } from "./frames.js";

const word = (x: number, y: number): ScreenWord => ({ display: 1, text: "Отправить", x, y, w: 100, h: 30 });
const UNDER_OWN = word(1500, 900); // под окном Джарвиса (его чат поверх Telegram)
const UNDER_NOTEPAD = word(100, 100); // под перекрывающим Блокнотом
const VISIBLE = word(800, 950); // видимая кнопка в Telegram
const OUTSIDE = word(800, 1050); // ниже окна Telegram (панель задач) — вне региона OCR

let side: FakeSidecar;
let sent: Prov[];
let words: ScreenWord[];

beforeEach(() => {
  _resetFramesForTest("g1b");
  resetCapturer([{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }]);
  side = useFakeSidecar();
  side.windows = [
    { hwnd: 1, pid: process.pid, process: "jarvis", title: "Джарвис", x: 1400, y: 800, w: 500, h: 250 },
    { hwnd: 3, pid: 300, process: "notepad", title: "Блокнот", x: 0, y: 0, w: 400, h: 300 },
    { hwnd: 5, pid: 200, process: "telegram", title: "Telegram", x: 0, y: 0, w: 1920, h: 1040, foreground: true },
  ];
  side.snapshot = { window: "Telegram", pid: 200, items: [], truncated: false }; // окно UIA-слепое → OCR-ступень
  words = [UNDER_OWN, UNDER_NOTEPAD, VISIBLE, OUTSIDE];
  sent = [];
  side.handlers.ocr = (a) => {
    sent.push(provOf(String(a.imageB64)));
    return ocrSees(words, String(a.imageB64));
  };
});

describe("G-12: OCR-ступень act в окне", () => {
  it("rect OCR = окно app (hwnd); строки под своим и под перекрывающим окном отброшены → одна цель, точка в DIP", async () => {
    const f = await findTarget("Отправить", Date.now() + 30_000, { hwnd: 5 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ox: 0, oy: 0, w: 1920, h: 1040, kx: 1 }); // окно Telegram, не весь монитор
    expect(f).toMatchObject({ via: "ocr", point: { x: 850, y: 965 } });
    expect(f.note).toMatch(/найдено OCR в окне «Telegram»/u);
    expect(side.mutations()).toHaveLength(0); // поиск ничего не нажимает
  });

  it("без app — переднее окно (не своё): тот же регион и та же цель", async () => {
    const f = await findTarget("Отправить", Date.now() + 30_000);
    expect(sent[0]).toMatchObject({ w: 1920, h: 1040 });
    expect(f.point).toEqual({ x: 850, y: 965 });
  });

  it("только строка под окном Джарвиса — цели нет (не «найдено» в собственном чате)", async () => {
    words = [UNDER_OWN];
    await expect(findTarget("Отправить", Date.now() + 30_000, { hwnd: 5 })).rejects.toThrow(/не найдена/u);
  });

  it("окно app не в списке (без заголовка) → OCR монитора, но строка под окном Джарвиса всё равно отброшена", async () => {
    words = [UNDER_OWN, VISIBLE];
    const f = await findTarget("Отправить", Date.now() + 30_000, { hwnd: 77 }); // hwnd, которого нет в window.list
    expect(sent[0]).toMatchObject({ w: 1920, h: 1080 }); // окна поиска не знаем — весь монитор
    expect(f.point).toEqual({ x: 850, y: 965 }); // единственная НЕ своя строка, а не «2 строки — неоднозначно»
  });

  it("две ВИДИМЫЕ строки в окне → честная неоднозначность со списком, ничего не выбрано", async () => {
    words = [VISIBLE, word(300, 600)];
    const p = findTarget("Отправить", Date.now() + 30_000, { hwnd: 5 });
    await expect(p).rejects.toBeInstanceOf(ActFindError);
    await expect(p).rejects.toThrow(/В окне «Telegram» 2 строки/u);
  });

  it("под точкой найденной строки — UIA-элемент: note называет его роль и имя", async () => {
    side.at = () => ({ handle: 41, role: "button", name: "Отправить сообщение", x: 790, y: 945, w: 120, h: 40 });
    const f = await findTarget("Отправить", Date.now() + 30_000, { hwnd: 5 });
    expect(f).toMatchObject({ via: "ocr", handle: "41", name: "Отправить сообщение" });
    expect(f.note).toMatch(/^под точкой Button «Отправить сообщение»; найдено OCR/u);
  });
});
