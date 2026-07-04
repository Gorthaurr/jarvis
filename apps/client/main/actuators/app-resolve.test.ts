import { describe, expect, it } from "vitest";
import { LaunchError, parseMarker, smartLaunch } from "./app-resolve.js";

describe("parseMarker — разбор маркера лаунчера", () => {
  it("парсит ключи через | (exe с pid)", () => {
    const kv = parseMarker("target=C:\\Windows\\system32\\notepad.exe | kind=exe | pid=1234 | display=notepad.exe | source=PATH");
    expect(kv.kind).toBe("exe");
    expect(kv.pid).toBe("1234");
    expect(kv.target).toContain("notepad.exe");
    expect(kv.source).toBe("PATH");
  });
  it("парсит URI-маркер (steam-игра)", () => {
    const kv = parseMarker("target=steam://rungameid/570 | kind=uri | display=Dota 2 | source=Steam(d=0)");
    expect(kv.target).toBe("steam://rungameid/570");
    expect(kv.display).toBe("Dota 2");
  });
});

// Интеграция с реальным PowerShell — только на Windows (dry-run, ничего не запускает).
const win = process.platform === "win32";
describe.runIf(win)("smartLaunch dry-run (Windows, реальный резолв)", () => {
  it("notepad резолвится в exe", async () => {
    const r = await smartLaunch("notepad", { dryRun: true });
    expect(r.kind).toBe("exe");
    expect(r.resolved.toLowerCase()).toContain("notepad");
  }, 30_000);

  it("ms-settings: резолвится как URI", async () => {
    const r = await smartLaunch("ms-settings:", { dryRun: true });
    expect(r.kind).toBe("uri");
    expect(r.resolved).toBe("ms-settings:");
  }, 30_000);

  it("несуществующее приложение → честный LaunchError not_found (не ложный успех)", async () => {
    await expect(smartLaunch("zzz_definitely_no_such_app_xyz", { dryRun: true })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(smartLaunch("zzz_definitely_no_such_app_xyz", { dryRun: true })).rejects.toBeInstanceOf(LaunchError);
  }, 30_000);
});
