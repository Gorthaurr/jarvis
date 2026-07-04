import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Мокаем electron: два монитора (основной слева 1920×1080, второй справа 2560×1440).
const displays = [
  { id: 1, size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, size: { width: 2560, height: 1440 }, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
];
vi.mock("electron", () => ({
  app: { getPath: () => { throw new Error("no userData in test"); } },
  screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] },
}));

import { MonitorManager } from "./monitors.js";

let c = 0;
const tmpCfg = (): string => join(tmpdir(), `jarvis-mon-${process.pid}-${Date.now()}-${c++}.json`);

describe("MonitorManager — мультимонитор (§6)", () => {
  it("monitorList: метки, флаги, по умолчанию рабочий = вторичный", () => {
    const m = new MonitorManager(tmpCfg());
    const l = m.monitorList();
    expect(l.monitors).toHaveLength(2);
    expect(l.jarvisIndex).toBeNull(); // авто
    // основной
    expect(l.monitors[0]!.isPrimary).toBe(true);
    expect(l.monitors[0]!.label).toContain("1920×1080");
    expect(l.monitors[0]!.label).toContain("основной");
    // второй — справа (x>primary.x), и он рабочий Джарвиса по умолчанию
    expect(l.monitors[1]!.isPrimary).toBe(false);
    expect(l.monitors[1]!.label).toContain("справа");
    expect(l.monitors[1]!.isJarvis).toBe(true);
  });

  it("setJarvisIndex назначает рабочий монитор (персист) и отражается в списке", () => {
    const cfg = tmpCfg();
    const m = new MonitorManager(cfg);
    m.setJarvisIndex(0);
    const l = m.monitorList();
    expect(l.jarvisIndex).toBe(0);
    expect(l.monitors[0]!.isJarvis).toBe(true);
    expect(l.monitors[1]!.isJarvis).toBe(false);
    // переживает «рестарт» (новый менеджер той же конфигурации)
    const m2 = new MonitorManager(cfg);
    expect(m2.jarvisIndex).toBe(0);
  });

  it("setJarvisIndex(null) → снова авто (вторичный)", () => {
    const m = new MonitorManager(tmpCfg());
    m.setJarvisIndex(1);
    m.setJarvisIndex(null);
    expect(m.jarvisIndex).toBeNull();
    expect(m.monitorList().monitors[1]!.isJarvis).toBe(true);
  });

  it("окно по умолчанию позиционируется на рабочем (НЕосновном) мониторе", () => {
    const m = new MonitorManager(tmpCfg());
    const pos = m.windowPosition(420, 640);
    // вторичный монитор начинается с x=1920 → окно там, а не на основном (x<1920)
    expect(pos.x).toBeGreaterThanOrEqual(1920);
  });

  it("target=primary → окно переезжает на ОСНОВНОЙ монитор (выведи на основной)", () => {
    const m = new MonitorManager(tmpCfg());
    m.setTarget("primary");
    expect(m.windowPosition(420, 640).x).toBeLessThan(1920); // основной слева (x<1920)
  });

  it("relayout-хук зовётся при смене цели и рабочего монитора (двигает окно)", () => {
    const m = new MonitorManager(tmpCfg());
    const moved = vi.fn();
    m.setRelayout(moved);
    m.setTarget("primary"); // 1: смена цели
    m.setJarvisIndex(1); // target=primary → НЕ двигаем
    m.setTarget("jarvis"); // 2: вернули цель
    m.setJarvisIndex(0); // 3: target=jarvis → переезд на новый рабочий
    expect(moved).toHaveBeenCalledTimes(3);
  });
});
