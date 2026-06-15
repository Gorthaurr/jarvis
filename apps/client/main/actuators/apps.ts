/**
 * Актуатор запуска/фокуса приложений на Windows (§6, M0-срез §17).
 *
 * РЕАЛЬНО работает на Windows:
 *   - app.launch — запуск процесса (notepad/calc/браузер и т.п.) через cmd `start`.
 *   - app.focus — вынос окна на передний план.
 *
 * Фокус временно делается через PowerShell + WScript.Shell.AppActivate
 * (// TODO(M3): заменить на сайдкар-стаб apps/sidecar-win, который умеет
 *  honest SetForegroundWindow по UIA-handle без хрупкого AppActivate по заголовку).
 *
 * Замечание (§3): этот актуатор НЕ дергает SendInput/координаты — только
 * управление процессами/окнами на уровне ОС.
 */
import { spawn } from "node:child_process";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:apps");

/** Результат низкоуровневого запуска: для маппинга в ActionResult.data. */
export interface LaunchOutcome {
  /** нормализованная цель запуска (то, что реально передали в ОС). */
  resolved: string;
  /** pid обёртки запуска (cmd), если получен. Само приложение detached. */
  pid?: number;
}

/**
 * Алиасы человеко-понятных имён → исполняемые/цели для Windows `start`.
 * Расширяется по мере появления навыков. tier0 (§3) опирается на тот же словарь.
 */
const APP_ALIASES: Record<string, string> = {
  // браузеры
  браузер: "msedge",
  browser: "msedge",
  edge: "msedge",
  chrome: "chrome",
  хром: "chrome",
  firefox: "firefox",
  // системные
  блокнот: "notepad",
  notepad: "notepad",
  заметки: "notepad",
  калькулятор: "calc",
  calc: "calc",
  calculator: "calc",
  проводник: "explorer",
  explorer: "explorer",
  paint: "mspaint",
  paint3d: "mspaint",
  терминал: "wt",
  terminal: "wt",
  cmd: "cmd",
  powershell: "powershell",
  настройки: "ms-settings:",
  settings: "ms-settings:",
};

/** Нормализовать пользовательское имя приложения в цель для ОС. */
export function resolveAppTarget(app: string): string {
  const key = app.trim().toLowerCase();
  return APP_ALIASES[key] ?? app.trim();
}

/**
 * Запустить приложение (§6 app.launch).
 *
 * Используем `cmd /c start "" <target>` — это надёжный путь на Windows:
 *   - умеет запускать как .exe из PATH, так и URI-схемы (ms-settings:),
 *   - не блокирует наш процесс (start возвращает управление сразу),
 *   - первый "" — это title-аргумент start (иначе путь в кавычках трактуется как title).
 */
export async function launchApp(app: string): Promise<LaunchOutcome> {
  const target = resolveAppTarget(app);
  log.info(`launch: "${app}" -> "${target}"`);

  return new Promise<LaunchOutcome>((resolve, reject) => {
    // detached + start: само приложение живёт независимо от Electron.
    const child = spawn("cmd", ["/c", "start", "", target], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.on("error", (e) => finish(() => reject(e)));
    // start завершается почти мгновенно; ловим exit как подтверждение, что команда ушла в ОС.
    child.on("exit", (code) => {
      if (code === 0 || code === null) {
        finish(() => resolve({ resolved: target, pid: child.pid }));
      } else {
        finish(() => reject(new Error(`start вернул код ${code} для "${target}"`)));
      }
    });

    // Защита: если ни error, ни exit не пришли (что маловероятно) — считаем успехом по факту spawn.
    setTimeout(() => finish(() => resolve({ resolved: target, pid: child.pid })), 1500);

    child.unref();
  });
}

/**
 * Вынести приложение на передний план (§6 app.focus).
 *
 * ВРЕМЕННЫЙ fallback: PowerShell + WScript.Shell.AppActivate по подстроке заголовка/имени.
 * AppActivate хрупок (зависит от точного заголовка, не работает для UWP-приложений),
 * поэтому это явно помечено как fallback.
 *
 * // TODO(M3): перенести в сайдкар apps/sidecar-win — SetForegroundWindow по UIA-handle,
 *   полученному из ui.ground, через IPC (main/actuators/ground.ts).
 */
export async function focusApp(app: string): Promise<LaunchOutcome> {
  const target = resolveAppTarget(app);
  log.info(`focus (AppActivate fallback): "${app}" -> "${target}"`);

  // Имя процесса без расширения и без URI-схемы — то, что AppActivate сможет сопоставить.
  const rawProbe = target.replace(/\.exe$/i, "").replace(/:$/, "");
  // БЕЗОПАСНОСТЬ: probe попадает в PowerShell-строковый литерал. Имя приходит из tier0
  // (текст пользователя) или с сервера — без экранирования одиночная кавычка вырывается
  // из литерала и исполняет произвольный PS (RCE). Удваиваем кавычки (PS-escape для '…')
  // и отсекаем заведомо не-имена (управляющие символы, перевод строки).
  const probe = rawProbe.replace(/[\r\n]/g, " ").replace(/'/g, "''");

  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$sh = New-Object -ComObject WScript.Shell;",
    // Сначала пробуем по имени процесса (более устойчиво, чем по заголовку).
    `$p = Get-Process -Name '${probe}' -ErrorAction SilentlyContinue | Select-Object -First 1;`,
    "if ($p) { [void]$sh.AppActivate($p.Id) }",
    `else { [void]$sh.AppActivate('${probe}') }`,
  ].join(" ");

  return new Promise<LaunchOutcome>((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", (e) => reject(e));
    child.on("exit", () => resolve({ resolved: target }));
  });
}
