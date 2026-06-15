import { describe, expect, it } from "vitest";
import { BROWSER_SPECS, detectApps, detectBrowsers, formatProfileSummary, progIdToBrowserId } from "./system-profiler.js";

describe("system-profiler (§9) — авто-детект окружения", () => {
  it("ProgId дефолтного браузера → id браузера", () => {
    expect(progIdToBrowserId("ChromeHTML")).toBe("chrome");
    expect(progIdToBrowserId("MSEdgeHTM")).toBe("edge");
    expect(progIdToBrowserId("MSEdgeHTM-8wekyb3d8bbwe")).toBe("edge"); // префиксное совпадение
    expect(progIdToBrowserId("BraveHTML")).toBe("brave");
    expect(progIdToBrowserId("YandexBrowserHTML")).toBe("yandex");
    expect(progIdToBrowserId("FirefoxURL")).toBe("firefox");
    expect(progIdToBrowserId("OperaStable")).toBe("opera");
  });

  it("неизвестный ProgId → undefined", () => {
    expect(progIdToBrowserId("SomethingElse")).toBeUndefined();
    expect(progIdToBrowserId("")).toBeUndefined();
  });

  it("спеки: Chromium-браузеры cdpCapable, Firefox — нет", () => {
    const byId = (id: string) => BROWSER_SPECS.find((s) => s.id === id);
    expect(byId("chrome")?.cdpCapable).toBe(true);
    expect(byId("edge")?.cdpCapable).toBe(true);
    expect(byId("yandex")?.cdpCapable).toBe(true);
    expect(byId("firefox")?.cdpCapable).toBe(false); // Marionette, не CDP
  });

  it("formatProfileSummary даёт читаемую сводку для системного промпта", () => {
    const s = formatProfileSummary({
      os: "win32 x64",
      defaultBrowser: { id: "chrome", name: "Google Chrome", exe: "c", userDataDir: "u", cdpCapable: true, isDefault: true },
      browsers: [
        { id: "chrome", name: "Google Chrome", exe: "c", userDataDir: "u", cdpCapable: true, isDefault: true },
        { id: "edge", name: "Microsoft Edge", exe: "e", userDataDir: "u2", cdpCapable: true, isDefault: false },
      ],
      apps: [{ id: "telegram", name: "Telegram", exe: "t" }],
    });
    expect(s).toContain("Google Chrome");
    expect(s).toContain("Microsoft Edge");
    expect(s).toContain("Telegram");
    expect(formatProfileSummary({ os: "win32 x64", browsers: [], apps: [] })).toBe("");
  });

  it("detectBrowsers/detectApps возвращают массивы (без падения)", () => {
    const browsers = detectBrowsers("chrome");
    expect(Array.isArray(browsers)).toBe(true);
    for (const b of browsers) {
      expect(typeof b.exe).toBe("string");
      expect(typeof b.cdpCapable).toBe("boolean");
    }
    expect(Array.isArray(detectApps())).toBe(true);
  });
});
