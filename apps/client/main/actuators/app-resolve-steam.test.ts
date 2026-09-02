/**
 * 🔴 Сверка запуска игры по URI — проверяется НАСТОЯЩИМ прогоном резолвера (греп по исходнику
 * правилом проекта запрещён: гард проверяется поведением).
 *
 * Живой дефект (ежедневная ложь): ветка URI без подсказки печатала LAUNCH:OK СРАЗУ после
 * Start-Process — то есть `steam://rungameid/<любой мусор>` возвращал успех без единой проверки, и
 * Джарвис говорил «Готово» на незапущенную игру. Теперь исход сверяется по двум реальным признакам:
 * процесс из папки установки (appmanifest → installdir → *.exe) и RunningAppID, который пишет сам Steam.
 *
 * ГРАНИЦА ОС МОКАЕТСЯ, ИГРА НЕ ЗАПУСКАЕТСЯ: JARVIS_STEAM_ROOT — временная библиотека с настоящим
 * appmanifest и файлами exe; JARVIS_STEAM_REG_KEY — настоящий ключ реестра под HKCU (читается тем же
 * Get-ItemProperty, что боевой); JARVIS_LAUNCH_NO_EXEC=1 — не звать Start-Process. Ложный успех этими
 * подменами получить нельзя: сверку они не отключают.
 *
 * РЕВЕРТ-ПРОВЕРКА (прогнана, результат честный): возврат строки
 * `if(-not $best.hint){ LAUNCH:OK; exit 0 }` вместо сверки → «несуществующий appid» и оба
 * «подтверждено RunningAppID» краснеют (успех перестаёт отличаться от провала).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { smartLaunch } from "./app-resolve.js";

const execFileAsync = promisify(execFile);
const describeWin = process.platform === "win32" ? describe : describe.skip;

/** Тестовый ключ реестра — роль `HKCU\Software\Valve\Steam` (боевой не трогаем). */
const REG_KEY = "HKCU:\\Software\\JarvisTest\\SteamStub";
const APPID = "570";
/** Аппид фикстуры «игра установлена, но НЕ идёт» (свой exe — не зависим от реальной Dota владельца). */
const STALE_APPID = "424242";

let steamRoot = "";
let emptyMenu = "";
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  saved[k] = process.env[k];
  process.env[k] = v;
}

async function ps(script: string): Promise<void> {
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

/** Записать «идущий appid» так же, как это делает Steam (DWORD в своей ветке HKCU). */
async function setRunningAppId(id: number): Promise<void> {
  await ps(`New-Item -Path '${REG_KEY}' -Force | Out-Null; Set-ItemProperty -Path '${REG_KEY}' -Name RunningAppID -Value ${id} -Type DWord`);
}

describeWin("запуск игры по steam:// сверяется, а не рапортуется успехом", () => {
  beforeAll(async () => {
    steamRoot = mkdtempSync(join(tmpdir(), "jarvis-steam-"));
    emptyMenu = mkdtempSync(join(tmpdir(), "jarvis-menu-empty-"));
    const apps = join(steamRoot, "steamapps");
    // Настоящий appmanifest (VDF) — из него резолвер обязан достать installdir.
    mkdirSync(apps, { recursive: true });
    writeFileSync(
      join(apps, `appmanifest_${APPID}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${APPID}"\n\t"name"\t\t"Dota 2"\n\t"installdir"\t\t"dota 2 beta"\n}\n`,
      "utf8",
    );
    // Раскладка как у настоящей игры: исполняемый лежит на 3 уровня глубже installdir.
    const bin = join(apps, "common", "dota 2 beta", "game", "bin", "win64");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "dota2.exe"), "", "utf8");
    writeFileSync(join(bin, "crashhandler64.exe"), "", "utf8"); // служебный — в подсказки попасть не должен

    // Второй фикстурный «аппид» — для случая «RunningAppID стоит, процесса нет». Имя exe заведомо
    // уникальное: на машине владельца настоящая Dota 2 может идти прямо сейчас, и проверка на
    // dota2.exe зависела бы от того, играет он или нет.
    writeFileSync(
      join(apps, `appmanifest_${STALE_APPID}.acf`),
      `"AppState"
{
	"appid"		"${STALE_APPID}"
	"name"		"Jarvis Test Game"
	"installdir"		"jarvis test game"
}
`,
      "utf8",
    );
    const staleBin = join(apps, "common", "jarvis test game");
    mkdirSync(staleBin, { recursive: true });
    writeFileSync(join(staleBin, "jarvistestgame-zzz.exe"), "", "utf8");

    setEnv("JARVIS_STEAM_ROOT", steamRoot);
    setEnv("JARVIS_STEAM_REG_KEY", REG_KEY);
    setEnv("JARVIS_LAUNCH_NO_EXEC", "1");
    setEnv("JARVIS_START_MENU_DIRS", emptyMenu);
    setEnv("JARVIS_STEAM_WAIT_MS", "1500");
    await setRunningAppId(0);
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of [steamRoot, emptyMenu]) if (d) rmSync(d, { recursive: true, force: true });
    try {
      await ps("Remove-Item -Path 'HKCU:\\Software\\JarvisTest' -Recurse -Force -ErrorAction SilentlyContinue");
    } catch {
      /* ключа могло не быть */
    }
  }, 60_000);

  it("несуществующий appid → ЧЕСТНЫЙ провал (раньше был безусловный успех)", async () => {
    await setRunningAppId(0);

    const err = await smartLaunch("steam://rungameid/999999999").then(
      (r) => ({ ok: true, r }) as const,
      (e: Error) => ({ ok: false, e }) as const,
    );

    expect(err.ok).toBe(false);
    if (err.ok) return;
    expect(err.e).toMatchObject({ code: "launch_failed" });
    expect(err.e.message).toContain("Steam принял команду");
  }, 60_000);

  it("установленная игра ИДЁТ (appid + живой процесс из папки установки) → успех", async () => {
    await setRunningAppId(Number(APPID));
    // «Игра идёт» — это appid В ПАРЕ с её процессом. Процесс не выдумываем: кладём в папку установки
    // файл с именем РЕАЛЬНО идущего процесса (сам прогон тестов — node.exe), поэтому CountProcs его
    // честно находит тем же Get-Process, что и в бою.
    const liveExe = join(steamRoot, "steamapps", "common", "dota 2 beta", "game", "bin", "win64", "node.exe");
    writeFileSync(liveExe, "", "utf8");
    try {
      const r = await smartLaunch(`steam://rungameid/${APPID}`);

      expect(r.kind).toBe("uri");
      expect(r.verified).toBe("appid-already");
    } finally {
      rmSync(liveExe, { force: true });
    }
  }, 60_000);

  it("🔴 RunningAppID стоит, а НИ ОДНОГО процесса игры нет → протухшее значение, честный отказ", async () => {
    // Адверс-ревью 2026-09-01: «уже запущено» объявлялось по ОДНОМУ признаку — значению в реестре,
    // которое переживает падение игры и самого Steam. Процессы при этом были посчитаны строкой выше
    // и выброшены. Владельцу говорили «Готово», игры на экране не было.
    await setRunningAppId(Number(STALE_APPID));

    const res = await smartLaunch(`steam://rungameid/${STALE_APPID}`).then(
      (r) => ({ ok: true, r }) as const,
      (e: Error) => ({ ok: false, e }) as const,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.e).toMatchObject({ code: "launch_failed" });
    // Причина ОТДЕЛЬНАЯ: тут RunningAppID как раз совпадает — общий текст «ни appid, ни процесс» врал бы.
    expect(res.e.message).toContain("могло остаться от прошлого сеанса");
  }, 60_000);

  it("RunningAppID появляется УЖЕ ПОСЛЕ команды → поллинг его видит (успех достижим, а не «всегда провал»)", async () => {
    await setRunningAppId(0);
    process.env.JARVIS_STEAM_WAIT_MS = "9000";
    // Steam пишет appid не мгновенно (бутстрап) — эмулируем задержку фоновым процессом.
    const bg = execFileAsync("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", `Start-Sleep -Milliseconds 1200; Set-ItemProperty -Path '${REG_KEY}' -Name RunningAppID -Value ${APPID} -Type DWord`,
    ]);

    try {
      const r = await smartLaunch(`steam://rungameid/${APPID}`);
      expect(r.verified).toBe("appid");
    } finally {
      process.env.JARVIS_STEAM_WAIT_MS = "1500";
      await bg.catch(() => undefined);
    }
  }, 60_000);

  it("путь к исполняемому берётся из appmanifest → installdir (служебные exe отсеяны)", async () => {
    const r = await smartLaunch(`steam://rungameid/${APPID}`, { dryRun: true });

    expect(r.appid).toBe(APPID);
    expect(r.hints ?? "").toContain("dota2");
    expect(r.hints ?? "").not.toContain("crashhandler");
  }, 60_000);

  it("игра находится по имени и тоже получает сверку (appid известен резолверу)", async () => {
    const r = await smartLaunch("дота", { dryRun: true });

    expect(r.resolved).toBe(`steam://rungameid/${APPID}`);
    expect(r.appid).toBe(APPID);
  }, 60_000);

  it("прочий URI (ms-settings:) не сломан, но помечен неподтверждённым", async () => {
    const r = await smartLaunch("ms-settings:");

    expect(r.kind).toBe("uri");
    expect(r.verified).toBe("handoff");
  }, 60_000);
});
