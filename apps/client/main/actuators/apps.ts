/**
 * Актуатор запуска/фокуса приложений на Windows (§6, M0-срез §17).
 *
 * РЕАЛЬНО работает на Windows:
 *   - app.launch — запуск процесса (notepad/calc/браузер и т.п.) через PowerShell Start-Process (цель — через ENV, анти-инъекция).
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
import { LaunchError, smartLaunch } from "./app-resolve.js";

const log = createLogger("actuator:apps");

/** Результат низкоуровневого запуска: для маппинга в ActionResult.data. */
export interface LaunchOutcome {
  /** Цель, реально ушедшая в ОС (exe-путь или URI). */
  resolved: string;
  /** Реальный PID запущенного процесса (для exe; у URI его нет). */
  pid?: number;
  /** Человекочитаемое имя запущенного (для подтверждения), напр. «Dota 2». */
  display?: string;
  /** Тип цели (exe|uri|path) и источник резолва (AppPaths/Steam/StartMenu/PATH/uri). */
  kind?: string;
  source?: string;
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
  // лаунчеры/бренды (имя бренда, не per-game хардкод): резолвер найдёт exe через App Paths/Пуск
  стим: "steam",
  дискорд: "discord",
};

/** Нормализовать пользовательское имя приложения в цель для ОС. */
export function resolveAppTarget(app: string): string {
  const key = app.trim().toLowerCase();
  return APP_ALIASES[key] ?? app.trim();
}

/**
 * Процессы, которые НИКОГДА нельзя закрывать (§6 «не навреди себе/системе»). Инцидент:
 * «закрой Доту» → агент послал Alt+F4 и закрыл САМ Джарвис. Сюда — сам Джарвис (electron/node/
 * имя клиента) и критические процессы Windows. Закрытие любого из них агентом — катастрофа
 * (закрыл себя / повесил систему), поэтому это жёсткий backstop поверх экспертизы агента.
 */
export const CRITICAL_PROCESSES: ReadonlySet<string> = new Set([
  // сам Джарвис
  "electron",
  "node",
  "jarvis",
  // критические процессы Windows
  "explorer",
  "dwm",
  "winlogon",
  "wininit",
  "csrss",
  "smss",
  "services",
  "lsass",
  "svchost",
  "system",
  "registry",
  "conhost",
  "fontdrvhost",
  "sihost",
  "ctfmon",
  "lockapp",
  "powershell",
  "pwsh",
  "cmd",
]);

/** Защищён ли процесс от закрытия (сам Джарвис / критический системный). Нормализует имя. */
export function isProtectedProcess(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/\.exe$/i, "");
  return CRITICAL_PROCESSES.has(n);
}

/**
 * Запустить приложение (§6 app.launch).
 *
 * БЕЗОПАСНОСТЬ: цель (имя из текста пользователя ИЛИ строка с сервера, в т.ч. URL из
 * browser.open-фоллбэка) НЕ интерполируем в командную строку. Прежний `cmd /c start "" <target>`
 * был уязвим к command-injection: cmd.exe re-парсит метасимволы (&|<>^) даже при spawn без
 * shell:true → цель вида «calc & shutdown /s /t 0» исполняла произвольную команду с правами юзера.
 * Теперь — PowerShell `Start-Process` с целью ЧЕРЕЗ ENV (как в closeApp): значение env не
 * парсится как команда, а трактуется как единый -FilePath (умеет и .exe из PATH, и URI ms-settings:).
 */
export async function launchApp(app: string): Promise<LaunchOutcome> {
  // Алиасы (браузер→msedge, настройки→ms-settings:, стим→steam, …) — быстрый known-good путь;
  // затем умный резолвер из источников истины ОС (App Paths / Steam-манифесты / Пуск / PATH) +
  // ЧЕСТНАЯ проверка факта запуска. Игры (Dota и пр.) резолвятся generically (steam://rungameid/<id>),
  // без хардкода. Провал резолва/запуска → LaunchError (диспетчер → error.runtime → честный isError,
  // а не ложное «Готово»). Что не резолвится — модель доберёт сама (web_search/code_run, см. персону).
  const query = resolveAppTarget(app);
  log.info(`launch: "${app}" -> резолв "${query}"`);
  const r = await smartLaunch(query);
  return { resolved: r.resolved, pid: r.pid, display: r.display, kind: r.kind, source: r.source };
}

export { LaunchError };

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
export interface FocusOutcome {
  resolved: string;
  /** РЕАЛЬНО ли вынесли на передний план (AppActivate вернул true). false → честный провал, не врём «переключил». */
  focused: boolean;
}

export async function focusApp(app: string): Promise<FocusOutcome> {
  const target = resolveAppTarget(app);

  // §Волна2 (2.4, закрывает TODO M3): ОСНОВНОЙ путь — сайдкар window.focus (SetForegroundWindow+
  // AttachThreadInput, <50мс, честный readback). PowerShell AppActivate ниже — фолбэк (сайдкар не
  // поднят / окно не нашёл / фокус не перешёл): ловит UWP-края и держит обратную совместимость.
  try {
    const { focusWindow } = await import("./windows.js");
    const probe = target.replace(/\.exe$/i, "").replace(/:$/, "");
    const r = await focusWindow({ query: probe });
    if (r.focused) {
      log.info(`focus (sidecar): "${app}" -> "${r.title}"`);
      return { resolved: target, focused: true };
    }
    log.debug(`focus: сайдкар не сфокусировал «${probe}» — фолбэк на AppActivate`);
  } catch (e) {
    log.debug(`focus: сайдкар недоступен (${e instanceof Error ? e.message : String(e)}) — фолбэк на AppActivate`);
  }

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
    `$name='${probe}'.ToLower();`,
    // Матч по вхождению (как в close) — ловит UWP/частичные имена, не только точное -Name.
    "$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $pn=$_.ProcessName.ToLower(); ($pn -eq $name -or ($name.Length -ge 4 -and ($pn -like ('*'+$name+'*') -or $name -like ('*'+$pn+'*')))) } | Select-Object -First 1;",
    // ЧЕСТНОСТЬ: AppActivate возвращает $true/$false — РАНЬШЕ его глушили [void], поэтому focus ВСЕГДА
    // рапортовал успех (даже для несуществующего приложения). Теперь печатаем реальный исход.
    `$r = if ($p) { $sh.AppActivate($p.Id) } else { $sh.AppActivate('${probe}') };`,
    "Write-Output ('FOCUSED:' + ([int][bool]$r));",
  ].join(" ");

  return new Promise<FocusOutcome>((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.on("error", (e) => reject(e));
    child.on("exit", () => {
      const m = out.match(/FOCUSED:(\d)/);
      resolve({ resolved: target, focused: m ? m[1] === "1" : false });
    });
  });
}

/** Результат закрытия приложения (§6 app.close). */
export interface CloseOutcome {
  resolved: string;
  /** Сколько процессов реально закрыто. */
  closed: number;
}

/**
 * БЕЗОПАСНО закрыть приложение ПО ПРОЦЕССУ (§6 app.close) — НЕ через Alt+F4 (который закрывает
 * активное окно, в т.ч. сам Джарвис — см. инцидент). graceful (CloseMainWindow, как клик по
 * крестику) по умолчанию; force=true — жёсткий Stop-Process (kill). SELF-EXCLUSION: имя цели и
 * все совпавшие процессы прогоняются через CRITICAL_PROCESSES + собственные PID Джарвиса —
 * закрыть себя/критический процесс невозможно (явная ошибка). Имя передаётся ЧЕРЕЗ ENV
 * (анти-инъекция PowerShell), не интерполяцией.
 */
export async function closeApp(app: string, force = false): Promise<CloseOutcome> {
  const target = resolveAppTarget(app).replace(/\.exe$/i, "").replace(/:$/, "");
  // Жёсткий backstop ДО запуска: цель — это сам Джарвис/критический процесс → отказ.
  if (isProtectedProcess(target)) {
    throw new Error(`нельзя закрыть «${app}»: это сам Джарвис или критический системный процесс`);
  }
  // Анти-wildcard: PowerShell `Get-Process -Name` трактует `*`/`?` как glob → «закрой *» снесло бы
  // десятки чужих процессов. Имя процесса их не содержит — отклоняем как небезопасную цель.
  if (/[*?]/.test(target)) {
    throw new Error(`нельзя закрыть «${app}»: имя процесса не должно содержать * или ?`);
  }
  log.info(`close: "${app}" -> "${target}" (force=${force})`);

  // Self-exclusion в самом PowerShell: исключаем собственные PID и критические имена — даже если
  // имя цели совпало с процессом Джарвиса/системы, такой процесс закрыт НЕ будет.
  const selfPids = [process.pid, process.ppid].filter((p): p is number => typeof p === "number" && p > 0).join(",");
  const critList = [...CRITICAL_PROCESSES].map((n) => `'${n}'`).join(",");
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$name=$env:JARVIS_CLOSE_NAME;",
    "$force=$env:JARVIS_CLOSE_FORCE -eq '1';",
    "$self=@($env:JARVIS_SELF_PIDS -split ',' | Where-Object { $_ });",
    `$crit=@(${critList});`,
    // Матч по ВХОЖДЕНИЮ в обе стороны (а не точное -Name): «calc»→CalculatorApp (UWP), «word»→WINWORD,
    // «excel»→EXCEL. Порог имени ≥4 символов — чтобы короткое не снесло лишнее. Точное совпадение — всегда.
    "$procs=Get-Process -ErrorAction SilentlyContinue | Where-Object { $pn=$_.ProcessName.ToLower(); ($pn -eq $name -or ($name.Length -ge 4 -and ($pn -like ('*'+$name+'*') -or $name -like ('*'+$pn+'*')))) -and $crit -notcontains $pn -and $self -notcontains [string]$_.Id };",
    "if(-not $procs){ Write-Output 'CLOSED:0'; exit 0 }",
    // Считаем закрытыми ТОЛЬКО реально исчезнувшие процессы (а не «CloseMainWindow вернул true»): UWP
    // (Калькулятор и пр.) на CloseMainWindow НЕ закрываются, но метод врёт true → раньше был ложный
    // «закрыл». Теперь: запомнить PID-ы → попытаться закрыть → подождать → пересчитать, кого НЕ стало.
    "$ids=@($procs | ForEach-Object { $_.Id });",
    "foreach($p in $procs){ if($force){ Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } else { $p.CloseMainWindow() | Out-Null } }",
    "Start-Sleep -Milliseconds $(if($force){500}else{1600});",
    "$still=@(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { $_.Id });",
    "$n=@($ids | Where-Object { $still -notcontains $_ }).Count;",
    "Write-Output \"CLOSED:$n\";",
  ].join(" ");

  return new Promise<CloseOutcome>((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        JARVIS_CLOSE_NAME: target,
        JARVIS_CLOSE_FORCE: force ? "1" : "0",
        JARVIS_SELF_PIDS: selfPids,
      },
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.on("error", (e) => reject(e));
    child.on("exit", () => {
      const m = out.match(/CLOSED:(\d+)/);
      resolve({ resolved: target, closed: m ? Number.parseInt(m[1]!, 10) : 0 });
    });
  });
}
