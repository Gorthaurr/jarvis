import { describe, expect, it, vi } from "vitest";

// Мультимонитор (2026-07-14): основной слева 1920×1080, второй справа 2560×1440. Проверяем, что
// listWindows привязывает окно к монитору по его физическому rect (эпизод «вруби демку в дискорде»:
// Дискорд на M1, браузер на M2 — раньше это было невидимо модели).
const displays = [
  { id: 1, size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, size: { width: 2560, height: 1440 }, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
];
vi.mock("electron", () => ({
  app: { getPath: () => { throw new Error("no userData in test"); } },
  screen: {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    // Физ.=DIP в тесте (scale 1) — displayForRect ведёт центр rect к монитору по bounds.
    screenToDipPoint: (p: { x: number; y: number }) => p,
    getDisplayNearestPoint: (p: { x: number; y: number }) =>
      displays.find((d) => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width) ?? displays[0],
  },
}));

// Мок сайдкара: отдаём сырые окна с rect на РАЗНЫХ мониторах.
const rawWindows = [
  { hwnd: 1, pid: 10, process: "Discord", title: "general — Discord", foreground: false, minimized: false, x: 100, y: 100, w: 1200, h: 800 }, // M1
  { hwnd: 2, pid: 20, process: "chrome", title: "YouTube — Chrome", foreground: true, minimized: false, x: 2100, y: 200, w: 1600, h: 900 }, // M2
  { hwnd: 3, pid: 30, process: "Telegram", title: "Telegram", foreground: false, minimized: true, x: -32000, y: -32000, w: 160, h: 160 }, // свёрнуто
];
vi.mock("./sidecar-client.js", () => ({
  sidecar: () => ({ ready: true, request: async () => ({ windows: rawWindows }) }),
}));
vi.mock("./input.js", () => ({ NotImplementedError: class extends Error {} }));

import { listWindows } from "./windows.js";

describe("listWindows — привязка окно→монитор (мультимонитор, эпизод «демка в дискорде»)", () => {
  it("Дискорд на M1 (осн.), Chrome на M2 — модель видит monitor у каждого окна", async () => {
    const wins = await listWindows();
    const discord = wins.find((w) => w.process === "Discord")!;
    const chrome = wins.find((w) => w.process === "chrome")!;
    expect(discord.monitorIndex).toBe(0); // левый монитор (основной)
    expect(discord.monitor).toContain("осн.");
    expect(chrome.monitorIndex).toBe(1); // правый монитор
    expect(chrome.monitor).toContain("монитор 2");
    // foreground сохраняется — модель знает, что переднее окно (Chrome) на M2, а Дискорд просто на M1,
    // НЕ свёрнут (minimized:false) — раньше отсюда рождалось ложное «свёрнут за хромом».
    expect(chrome.foreground).toBe(true);
    expect(discord.minimized).toBe(false);
  });

  it("ревью #5: свёрнутое окно (rect off-screen -32000) → монитор «свёрнуто», не ложный «монитор N»", async () => {
    const wins = await listWindows();
    const tg = wins.find((w) => w.process === "Telegram")!;
    expect(tg.minimized).toBe(true);
    expect(tg.monitor).toBe("свёрнуто"); // не «монитор 2» от nearest-point промаха по off-screen rect
  });
});
