/**
 * Ревью 2026-09-24 (T-F5, живой провал «Джарвис, открой дискорд»): ярлык Discord.lnk = `Update.exe
 * --processStart Discord.exe`, а резолвер читал только TargetPath и запускал голый Update.exe, который тут же
 * выходил. Проверяется НАСТОЯЩИМ PowerShell-резолвером на временном меню Пуск (JARVIS_START_MENU_DIRS), как
 * гард деинсталлятора (app-resolve-uninstaller.test.ts): ранжирование живёт в PS, копию логики в TS для
 * «чистого» теста не заводим — две копии разошлись бы.
 *
 * Дубли расставлены так, что БЕЗ фикса побеждает неверный ярлык (равный score → короче путь цели), —
 * иначе тест прошёл бы и на сломанной реализации.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseMarker, smartLaunch } from "./app-resolve.js";

const execFileAsync = promisify(execFile);
const describeWin = process.platform === "win32" ? describe : describe.skip;
const NOTEPAD = "C:\\Windows\\System32\\notepad.exe";
const WSCRIPT = "C:\\Windows\\System32\\wscript.exe";

let menu = "";
let prevMenus: string | undefined;

async function ps(cmd: string, env: Record<string, string>): Promise<void> {
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    env: { ...process.env, ...env },
  });
}

/** Ярлык через WScript.Shell — как его создаёт установщик; значения через ENV (кириллица/пробелы в путях). */
async function lnk(path: string, target: string, args = "", wd = ""): Promise<void> {
  await ps(
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:L); $s.TargetPath=$env:T; $s.Arguments=$env:A; if($env:W){$s.WorkingDirectory=$env:W}; $s.Save()",
    { L: path, T: target, A: args, W: wd },
  );
}

/** Копия системного exe под нужным именем (резолвер проверяет существование цели). */
async function exeCopy(dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, name);
  await ps("Copy-Item -LiteralPath $env:S -Destination $env:D -Force", { S: NOTEPAD, D: dst });
  return dst;
}

describe("parseMarker: аргументы ярлыка в маркере", () => {
  it("args=… разбирается; пустое значение — пустая строка", () => {
    const kv = parseMarker("target=C:\\x\\Update.exe | kind=exe | display=Discord | source=StartMenu(d=0) | args=--processStart Discord.exe");
    expect(kv.args).toBe("--processStart Discord.exe");
    expect(parseMarker("target=a | args=").args).toBe("");
  });
});

describeWin("резолвер: аргументы ярлыка (Squirrel Update.exe --processStart)", () => {
  beforeAll(() => {
    menu = mkdtempSync(join(tmpdir(), "jarvis-lnkargs-"));
    prevMenus = process.env.JARVIS_START_MENU_DIRS;
    process.env.JARVIS_START_MENU_DIRS = menu;
  }, 60_000);

  afterAll(() => {
    if (prevMenus === undefined) delete process.env.JARVIS_START_MENU_DIRS;
    else process.env.JARVIS_START_MENU_DIRS = prevMenus;
    if (menu) rmSync(menu, { recursive: true, force: true });
  });

  it("ярлык Update.exe --processStart X.exe резолвится С аргументами, сверка — по процессу X", async () => {
    const dir = join(menu, "ZzSquirrel");
    const upd = await exeCopy(dir, "Update.exe");
    await lnk(join(menu, "ZzSquirrelApp.lnk"), upd, "--processStart ZzSquirrelApp.exe", dir);
    const r = await smartLaunch("ZzSquirrelApp", { dryRun: true });
    expect(r.resolved.toLowerCase()).toContain("update.exe");
    expect(r.args).toBe("--processStart ZzSquirrelApp.exe");
    expect(r.hints).toBe("ZzSquirrelApp");
  }, 60_000);

  it("дубль ярлыков: голый Update.exe (апдейтер) проигрывает ярлыку с --processStart", async () => {
    const bare = await exeCopy(join(menu, "a"), "Update.exe"); // путь КОРОЧЕ — без фикса выиграл бы он
    const full = await exeCopy(join(menu, "bbbb"), "Update.exe");
    mkdirSync(join(menu, "m1"), { recursive: true });
    mkdirSync(join(menu, "m2"), { recursive: true });
    await lnk(join(menu, "m1", "ZzDupApp.lnk"), bare);
    await lnk(join(menu, "m2", "ZzDupApp.lnk"), full, "--processStart ZzDupApp.exe");
    const r = await smartLaunch("ZzDupApp", { dryRun: true });
    expect(r.args).toBe("--processStart ZzDupApp.exe");
    expect(r.resolved.toLowerCase()).toContain("bbbb");
  }, 60_000);

  it("голый Update.exe штрафуется сам по себе: проигрывает даже ярлыку с чужим именем exe", async () => {
    const bare = await exeCopy(join(menu, "e"), "Update.exe"); // путь короче — без штрафа выиграл бы он
    const app = await exeCopy(join(menu, "ffffffff"), "Runner.exe");
    mkdirSync(join(menu, "m5"), { recursive: true });
    mkdirSync(join(menu, "m6"), { recursive: true });
    await lnk(join(menu, "m5", "ZzUpd.lnk"), bare);
    await lnk(join(menu, "m6", "ZzUpd.lnk"), app);
    const r = await smartLaunch("ZzUpd", { dryRun: true });
    expect(r.resolved.toLowerCase()).toContain("runner.exe");
  }, 60_000);

  it("дубль ярлыков: выигрывает тот, чей exe совпадает с запросом", async () => {
    const other = await exeCopy(join(menu, "c"), "Helper.exe"); // путь короче — без фикса выиграл бы он
    const same = await exeCopy(join(menu, "ddddddd"), "ZzPick.exe");
    mkdirSync(join(menu, "m3"), { recursive: true });
    mkdirSync(join(menu, "m4"), { recursive: true });
    await lnk(join(menu, "m3", "ZzPick.lnk"), other);
    await lnk(join(menu, "m4", "ZzPick.lnk"), same);
    const r = await smartLaunch("ZzPick", { dryRun: true });
    expect(r.resolved.toLowerCase()).toContain("zzpick.exe");
  }, 60_000);

  it("запуск передаёт аргументы ярлыка процессу (wscript пишет маркер-файл только с аргументами)", async () => {
    const dir = join(menu, "probe");
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "probe.js");
    const marker = join(dir, "marker.txt");
    writeFileSync(
      script,
      'var f=new ActiveXObject("Scripting.FileSystemObject").CreateTextFile(WScript.Arguments(0)); f.Write("ok"); f.Close();',
      "utf8",
    );
    await lnk(join(menu, "ZzArgsProbe.lnk"), WSCRIPT, `"${script}" "${marker}"`, dir);
    let pid: number | undefined;
    try {
      const r = await smartLaunch("ZzArgsProbe");
      pid = r.pid;
      for (let i = 0; i < 20 && !existsSync(marker); i += 1) await new Promise((res) => setTimeout(res, 200));
      expect(existsSync(marker)).toBe(true);
    } finally {
      // Без аргументов wscript открыл бы окно настроек — не оставляем его висеть (только наш pid).
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          /* уже вышел */
        }
      }
    }
  }, 60_000);
});
