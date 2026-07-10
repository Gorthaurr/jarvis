import { describe, expect, it } from "vitest";
import { BROWSER_SPECS, detectApps, detectAutomationTools, detectBrowsers, formatHardwareSummary, formatProfileSummary, onPath, progIdToBrowserId } from "./system-profiler.js";

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
      tools: [{ id: "ffmpeg", name: "FFmpeg", surface: "видео через code_run" }],
    });
    expect(s).toContain("Google Chrome");
    expect(s).toContain("Microsoft Edge");
    expect(s).toContain("Telegram");
    expect(s).toContain("FFmpeg"); // арсенал программного пути попал в сводку
    expect(formatProfileSummary({ os: "win32 x64", browsers: [], apps: [], tools: [] })).toBe("");
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

  it("onPath находит команду по .exe в каталоге PATH (инжектируемый exists)", () => {
    const has = (p: string): boolean => p === "C:\\bin\\ffmpeg.exe";
    expect(onPath("ffmpeg", "C:\\bin;C:\\other", has)).toBe(true);
    expect(onPath("git", "C:\\bin;C:\\other", has)).toBe(false);
  });

  it("detectAutomationTools отдаёт каталог с surface для найденных (инжектируемый exists/PATH)", () => {
    // На PATH «есть» только ffmpeg и git (по .exe).
    const has = (p: string): boolean => p.endsWith("ffmpeg.exe") || p.endsWith("git.exe");
    const tools = detectAutomationTools(has, "C:\\bin");
    const ids = tools.map((t) => t.id);
    expect(ids).toContain("ffmpeg");
    expect(ids).toContain("git");
    expect(ids).not.toContain("docker");
    // surface — непустая подсказка «как драйвить»
    expect(tools.find((t) => t.id === "ffmpeg")?.surface).toMatch(/code_run/);
  });

  it("detectAutomationTools находит OBS по известному exe-пути", () => {
    const has = (p: string): boolean => p.toLowerCase().includes("obs-studio");
    const tools = detectAutomationTools(has, "");
    expect(tools.map((t) => t.id)).toContain("obs");
    expect(tools.find((t) => t.id === "obs")?.surface).toMatch(/obs_request/);
  });

  it("formatHardwareSummary: компактная строка железа (CPU/GPU/VRAM/мать/мониторы)", () => {
    const s = formatHardwareSummary({
      cpu: "AMD Ryzen 7 7800X3D",
      cores: "8 ядер / 16 потоков",
      gpu: ["NVIDIA GeForce RTX 5080"],
      vram: "16 ГБ",
      motherboard: "MSI B850 GAMING PLUS WIFI",
      ramGB: 64,
      disks: ["Samsung 990 EVO Plus 1TB"],
      monitors: ["MSI MAG 271QP X28", "SAM F27G3xTF"],
      audio: ["Realtek"],
    });
    expect(s).toContain("AMD Ryzen 7 7800X3D");
    expect(s).toContain("RTX 5080 16 ГБ"); // VRAM рядом с видяхой
    expect(s).toContain("64 ГБ");
    expect(s).toContain("MSI MAG 271QP X28"); // мониторы как устройства
    expect(formatHardwareSummary({})).toBe(""); // пусто → пустая строка
  });
});
