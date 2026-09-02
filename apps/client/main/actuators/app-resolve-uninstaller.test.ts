/**
 * 🔴 Гард «не запускать деинсталлятор» — проверяется НАСТОЯЩИМ прогоном резолвера.
 *
 * Живой инцидент 2026-09-01: на «Джарвис, открой Telegram» резолвер выбрал ярлык
 * «Деинсталлировать Telegram» → `unins000.exe` и запустил ЕГО. Владелец сказал: «ты только что
 * по удалить телеграм десктоп». Причина — правило Contains обнуляло расстояние ЛЮБОМУ имени,
 * содержащему запрос, а тай-брейк по длине пути у `Telegram.exe` и `unins000.exe` совпадал.
 *
 * Тест поднимает ВРЕМЕННОЕ меню Пуск (JARVIS_START_MENU_DIRS) с двумя настоящими .lnk и гоняет
 * реальный PowerShell-резолвер в dry-run. Греп по исходнику здесь запрещён правилом проекта:
 * гард обязан проверяться поведением.
 *
 * РЕВЕРТ-ПРОВЕРКА (прогнана 2026-09-01, результат честный, а не предполагаемый): рубежи
 * ИЗБЫТОЧНЫ по замыслу, поэтому снятие ОДНОГО теста не роняет — возврат старого правила Contains
 * при живом badTarget оставляет все 3 зелёными (цель-деинсталлятор отсекается по имени файла).
 * Падает при снятии ОБОИХ (2 из 3 красных, включая ключевой) — то есть тест проверяет ИТОГ
 * «деинсталлятор не запускается», а не конкретную реализацию, и это правильный контракт.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { smartLaunch } from "./app-resolve.js";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";
const describeWin = isWin ? describe : describe.skip;

/** Настоящие exe-цели: гард смотрит на ИМЯ файла цели, поэтому берём существующие системные. */
const APP_TARGET = "C:\\Windows\\System32\\notepad.exe";
const UNINST_TARGET = "C:\\Windows\\System32\\charmap.exe"; // роль «деинсталлятора» — по имени ярлыка/копии

let menuDir = "";
let prevMenus: string | undefined;

/** Создать .lnk через WScript.Shell — так же, как их создаёт установщик. */
async function makeShortcut(name: string, target: string): Promise<void> {
  const ps = [
    "$w = New-Object -ComObject WScript.Shell",
    `$s = $w.CreateShortcut([IO.Path]::Combine($env:JARVIS_TEST_MENU, '${name}.lnk'))`,
    `$s.TargetPath = '${target}'`,
    "$s.Save()",
  ].join("; ");
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    env: { ...process.env, JARVIS_TEST_MENU: menuDir },
  });
}

describeWin("резолвер приложений: деинсталлятор не запускается по «открой»", () => {
  beforeAll(async () => {
    menuDir = mkdtempSync(join(tmpdir(), "jarvis-menu-"));
    prevMenus = process.env.JARVIS_START_MENU_DIRS;
    process.env.JARVIS_START_MENU_DIRS = menuDir;
    // Копия деинсталлятора под характерным именем — гард узнаёт цель по имени файла (unins*).
    await execFileAsync("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", `Copy-Item '${UNINST_TARGET}' (Join-Path $env:JARVIS_TEST_MENU 'unins000.exe') -Force`,
    ], { env: { ...process.env, JARVIS_TEST_MENU: menuDir } });
  }, 60_000);

  afterAll(() => {
    if (prevMenus === undefined) delete process.env.JARVIS_START_MENU_DIRS;
    else process.env.JARVIS_START_MENU_DIRS = prevMenus;
    if (menuDir) rmSync(menuDir, { recursive: true, force: true });
  });

  it("выбирает ПРИЛОЖЕНИЕ, а не соседний ярлык «Деинсталлировать X»", async () => {
    await makeShortcut("TestApp", APP_TARGET);
    await makeShortcut("Деинсталлировать TestApp", join(menuDir, "unins000.exe"));

    const r = await smartLaunch("TestApp", { dryRun: true });

    expect(r.resolved.toLowerCase()).toContain("notepad.exe");
    expect(r.resolved.toLowerCase()).not.toContain("unins");
  }, 60_000);

  it("когда ЕСТЬ только деинсталлятор — честный отказ, а не запуск удаления", async () => {
    const only = mkdtempSync(join(tmpdir(), "jarvis-menu-only-"));
    const prev = process.env.JARVIS_START_MENU_DIRS;
    try {
      await execFileAsync("powershell", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", `Copy-Item '${UNINST_TARGET}' (Join-Path $env:JARVIS_TEST_MENU 'unins000.exe') -Force`,
      ], { env: { ...process.env, JARVIS_TEST_MENU: only } });
      const saved = menuDir;
      menuDir = only;
      process.env.JARVIS_START_MENU_DIRS = only;
      await makeShortcut("Удалить ZzzUniqueApp", join(only, "unins000.exe"));
      menuDir = saved;

      await expect(smartLaunch("ZzzUniqueApp", { dryRun: true })).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.JARVIS_START_MENU_DIRS;
      else process.env.JARVIS_START_MENU_DIRS = prev;
      rmSync(only, { recursive: true, force: true });
    }
  }, 60_000);

  it("точное имя приложения выигрывает у ярлыка «X Справка» из того же пакета", async () => {
    await makeShortcut("Notes", APP_TARGET);
    await makeShortcut("Notes Справка", "C:\\Windows\\System32\\charmap.exe");

    const r = await smartLaunch("Notes", { dryRun: true });

    expect(r.resolved.toLowerCase()).toContain("notepad.exe");
  }, 60_000);
});
