import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkCtx, stubServer, win } from "../testkit.js";
import { clipboardHas, notPoweredOff, reminderStored, soundOff, volumeLowered, volumeRaised } from "./sys.js";
import { noNewWindows, windowGone, windowOnMonitor, windowOpen, windowsUntouched, windowText } from "./win.js";

const calc = win({ hwnd: 1002, title: "Калькулятор", process: "CalculatorApp" });
const chrome = win({ hwnd: 1004, title: "Google Chrome", process: "chrome" });
const note = win({ hwnd: 1006, title: "Безымянный — Блокнот", process: "notepad", text: "купить молоко" });

describe("окна", () => {
  it("windowOpen / windowText: зелёный при окне с текстом, красный без него", () => {
    const c = mkCtx({ desktop: { windows: [note] } });
    expect(windowOpen(c, { process: /notepad/u }).pass).toBe(true);
    expect(windowText(c, { process: /notepad/u }, "Купить молоко").pass).toBe(true);
    expect(windowText(c, { process: /notepad/u }, "хлеб")).toMatchObject({ pass: false, why: expect.stringContaining("купить молоко") });
    expect(windowOpen(mkCtx({ desktop: { windows: [chrome] } }), { process: /notepad/u }).pass).toBe(false);
    expect(windowText(mkCtx({ desktop: { windows: [chrome] } }), { process: /notepad/u }, "x").pass).toBe(false);
  });

  it("windowGone: красный, пока окно живо", () => {
    expect(windowGone(mkCtx({ desktop: { windows: [chrome] } }), { process: /calc/iu }).pass).toBe(true);
    expect(windowGone(mkCtx({ desktop: { windows: [calc, chrome] } }), { process: /calc/iu }).pass).toBe(false);
  });

  it("windowsUntouched: закрыли лишнее — красный; закрыли только названное — зелёный", () => {
    const before = { windows: [calc, chrome, note] };
    expect(windowsUntouched(mkCtx({ before, desktop: { windows: [chrome, note] } }), { process: /calc/iu }).pass).toBe(true);
    expect(windowsUntouched(mkCtx({ before, desktop: { windows: [note] } }), { process: /calc/iu })).toMatchObject({ pass: false, why: expect.stringContaining("Google Chrome") });
  });

  it("windowOnMonitor: смотрит именно на нужный монитор", () => {
    const c = mkCtx({ desktop: { windows: [{ ...chrome, monitor: 2 }] } });
    expect(windowOnMonitor(c, { process: /chrome/u }, 2).pass).toBe(true);
    expect(windowOnMonitor(c, { process: /chrome/u }, 1)).toMatchObject({ pass: false, why: expect.stringContaining("на мониторе 2") });
    expect(windowOnMonitor(c, { process: /word/u }, 1).pass).toBe(false);
  });

  it("noNewWindows: новое окно — красный", () => {
    expect(noNewWindows(mkCtx({ before: { windows: [chrome] }, desktop: { windows: [chrome] } })).pass).toBe(true);
    expect(noNewWindows(mkCtx({ before: { windows: [chrome] }, desktop: { windows: [chrome, note] } })).pass).toBe(false);
  });
});

describe("система", () => {
  it("volumeLowered / volumeRaised: направление и границы", () => {
    const at = (before: number, vol: number, muted = false) => mkCtx({ before: { volume: before }, desktop: { volume: vol, muted } });
    expect(volumeLowered(at(60, 50)).pass).toBe(true);
    expect(volumeLowered(at(60, 60)).pass).toBe(false);
    expect(volumeLowered(at(60, 70)).pass).toBe(false);
    expect(volumeLowered(at(60, 0)).pass).toBe(false); // «потише» ≠ «без звука»
    expect(volumeLowered(at(60, 40, true)).pass).toBe(false);
    expect(volumeRaised(at(30, 40)).pass).toBe(true);
    expect(volumeRaised(at(30, 20)).pass).toBe(false);
    expect(volumeRaised(at(30, 40, true)).pass).toBe(false);
  });

  it("soundOff: mute или ноль — зелёный, иначе красный", () => {
    expect(soundOff(mkCtx({ desktop: { muted: true } })).pass).toBe(true);
    expect(soundOff(mkCtx({ desktop: { volume: 0 } })).pass).toBe(true);
    expect(soundOff(mkCtx({ desktop: { volume: 40, muted: false } })).pass).toBe(false);
  });

  it("clipboardHas: все куски обязательны", () => {
    const c = mkCtx({ desktop: { clipboard: "улица Ленина, дом 5" } });
    expect(clipboardHas(c, "Ленина", /дом 5/u).pass).toBe(true);
    expect(clipboardHas(c, "Ленина", "квартира").pass).toBe(false);
    expect(clipboardHas(mkCtx(), "x").pass).toBe(false);
  });

  it("notPoweredOff: эффект ИЛИ команда выключения — красный; отмена и пустота — зелёный", () => {
    const eff = (op: string) => ({ n: 1, at: 0, kind: "system.power", detail: { op } });
    const cmd = (op: string) => ({ cmd: { kind: "system.power", op } as never, result: { commandId: "c", ok: true, durationMs: 1 }, ms: 1 });
    expect(notPoweredOff(mkCtx({ desktop: { effects: [eff("shutdown")] } })).pass).toBe(false);
    expect(notPoweredOff(mkCtx({ turns: [{ actions: [cmd("restart")] }] })).pass).toBe(false);
    expect(notPoweredOff(mkCtx({ desktop: { effects: [eff("cancel")] }, turns: [{ actions: [cmd("cancel")] }] })).pass).toBe(true);
    expect(notPoweredOff(mkCtx()).pass).toBe(true);
  });
});

describe("reminderStored (durable-стор сервера)", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const put = (items: unknown[]): ReturnType<typeof mkCtx> => {
    dir = mkdtempSync(join(tmpdir(), "eval-rem-"));
    writeFileSync(join(dir, "reminders.json"), JSON.stringify(items));
    return mkCtx({ server: stubServer({ dataDir: dir }), userId: "me" });
  };
  const rem = (over: Record<string, unknown> = {}) => ({ userId: "me", status: "scheduled", text: "Позвонить маме", fireAt: Date.now() + 600_000, ...over });

  it("зелёный: моё напоминание с нужным текстом через ~10 минут", async () => {
    expect((await reminderStored(put([rem()]), { text: "позвонить маме", minSec: 540, maxSec: 660 })).pass).toBe(true);
  });
  it("красный: срок не тот / текст не тот / чужое / отменено", async () => {
    const o = { text: "позвонить маме", minSec: 540, maxSec: 660 };
    expect(await reminderStored(put([rem({ fireAt: Date.now() + 60_000 })]), o)).toMatchObject({ pass: false, why: expect.stringContaining("ждали 540") });
    expect((await reminderStored(put([rem({ text: "купить хлеб" })]), o)).pass).toBe(false);
    expect((await reminderStored(put([rem({ userId: "чужой" })]), o)).pass).toBe(false);
    expect((await reminderStored(put([rem({ status: "cancelled" })]), o)).pass).toBe(false);
  });
});
