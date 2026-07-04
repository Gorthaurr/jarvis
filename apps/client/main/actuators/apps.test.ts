/**
 * app.close — БЕЗОПАСНОЕ закрытие приложений (§6). После инцидента «закрой Доту → Джарвис
 * закрыл сам себя» (Alt+F4): закрываем по процессу, и self-exclusion НЕ даёт закрыть сам
 * Джарвис/критический процесс.
 */
import { describe, expect, it } from "vitest";
import { CRITICAL_PROCESSES, closeApp, isProtectedProcess, resolveAppTarget } from "./apps.js";

describe("app.close self-protection (§6)", () => {
  it("сам Джарвис и критические процессы — защищены (нельзя закрыть)", () => {
    for (const p of ["electron", "node", "jarvis", "explorer", "dwm", "winlogon", "csrss", "services", "lsass"]) {
      expect(isProtectedProcess(p)).toBe(true);
    }
    // регистр и .exe нормализуются
    expect(isProtectedProcess("Electron.exe")).toBe(true);
    expect(isProtectedProcess(" EXPLORER ")).toBe(true);
  });

  it("обычные приложения/игры — НЕ защищены (можно закрывать)", () => {
    for (const p of ["dota2", "notepad", "chrome", "discord", "steam", "calc", "code"]) {
      expect(isProtectedProcess(p)).toBe(false);
    }
  });

  it("closeApp на защищённый процесс БРОСАЕТ (не закрывает себя/систему)", async () => {
    await expect(closeApp("electron")).rejects.toThrow(/Джарвис|критическ/i);
    await expect(closeApp("explorer")).rejects.toThrow(/критическ|Джарвис/i);
    // алиас «проводник» резолвится в explorer → тоже защищён
    expect(resolveAppTarget("проводник")).toBe("explorer");
    await expect(closeApp("проводник")).rejects.toThrow();
  });

  it("CRITICAL_PROCESSES включает и Джарвис (electron/node), и системные", () => {
    expect(CRITICAL_PROCESSES.has("electron")).toBe(true);
    expect(CRITICAL_PROCESSES.has("node")).toBe(true);
    expect(CRITICAL_PROCESSES.has("winlogon")).toBe(true);
  });
});
