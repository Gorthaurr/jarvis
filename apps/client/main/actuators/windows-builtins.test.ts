/**
 * Ревью 2026-09-24: «блокнот» открывал обёртку Git (usr\bin\notepad из PATH), «командная строка» — ярлык VS2015
 * ARM Cross Tools, «панель управления» — панель Рутокена, «диспетчер задач»/«параметры» не находились вовсе.
 * Реверт: убери `builtinLaunchPath(query) ??` в apps.ts launchApp — тест «launchApp идёт в System32» упадёт.
 */
import { describe, expect, it, vi } from "vitest";

const smartLaunch = vi.fn(async (q: string) => ({ resolved: q, kind: "exe", display: q, source: "path", verified: "process" }));
vi.mock("./app-resolve.js", () => ({ smartLaunch: (q: string) => smartLaunch(q), LaunchError: class extends Error {} }));

const { builtinLaunchPath } = await import("./windows-builtins.js");
const { launchApp, resolveAppTarget } = await import("./apps.js");

describe("встроенные программы Windows", () => {
  it("русские имена резолвятся в процессы, а не уходят поиском по Пуску", () => {
    expect(resolveAppTarget("Диспетчер задач")).toBe("taskmgr");
    expect(resolveAppTarget("параметры")).toBe("ms-settings:");
    expect(resolveAppTarget("командная строка")).toBe("cmd");
    expect(resolveAppTarget("командную строку")).toBe("cmd"); // так её отдаёт роутер из «открой командную строку»
    expect(resolveAppTarget("панель управления")).toBe("control");
    expect(resolveAppTarget("блокнот")).toBe("notepad"); // алиас — имя процесса: его же зовут фокус и закрытие
    // Контроль-2: «консоль» в игре/браузере — не cmd («закрой консоль» гасила бы все cmd.exe владельца).
    expect(resolveAppTarget("консоль")).toBe("консоль");
  });

  it("путь запуска — из %SystemRoot%, и только если файл есть", () => {
    const yes = () => true;
    expect(builtinLaunchPath("notepad", yes, "C:\\Windows")).toBe("C:\\Windows\\System32\\notepad.exe");
    expect(builtinLaunchPath("Taskmgr.exe", yes, "D:\\Win")).toBe("D:\\Win\\System32\\Taskmgr.exe");
    expect(builtinLaunchPath("explorer", yes, "C:\\Windows")).toBe("C:\\Windows\\explorer.exe");
    expect(builtinLaunchPath("notepad", () => false, "C:\\Windows")).toBeUndefined();
    expect(builtinLaunchPath("discord", yes, "C:\\Windows")).toBeUndefined();
  });

  it("launchApp(«блокнот») идёт в System32, не в PATH", async () => {
    smartLaunch.mockClear();
    await launchApp("блокнот");
    const arg = smartLaunch.mock.calls[0]?.[0] ?? "";
    expect(arg.toLowerCase()).toMatch(/\\system32\\notepad\.exe$/u);
  });

  it("не-встроенное приложение резолвится как раньше", async () => {
    smartLaunch.mockClear();
    await launchApp("дискорд");
    expect(smartLaunch.mock.calls[0]?.[0]).toBe("discord");
  });
});
