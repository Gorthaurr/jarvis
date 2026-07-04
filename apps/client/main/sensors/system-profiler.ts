/**
 * Профилировщик окружения (§9, персонализация): САМ определяет, чем пользуется человек,
 * чтобы Джарвис подстраивался, а не работал по захардкоженным предположениям.
 *
 * Определяет: дефолтный браузер (из реестра UserChoice), установленные браузеры (с путём
 * профиля и поддержкой CDP), ключевые приложения. Результат уходит агенту в системный
 * промпт — модель видит окружение конкретного пользователя и адаптируется.
 *
 * Маппинг (ProgId→браузер, спеки путей) — ЧИСТЫЕ функции (тестируются). Доступ к реестру/
 * ФС — отдельный IO-слой.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BrowserInfo {
  id: string;
  name: string;
  exe: string;
  /** Каталог профиля (реальные логины пользователя). */
  userDataDir: string;
  /** Управляем по Chrome DevTools Protocol (Chromium-семейство). Firefox — нет. */
  cdpCapable: boolean;
  isDefault: boolean;
}

export interface AppInfo {
  id: string;
  name: string;
  exe: string;
}

/** Программно-управляемый инструмент на машине (CLI/локальный API) + как его драйвить. */
export interface ToolCap {
  id: string;
  name: string;
  /** Короткая подсказка агенту: КАК управлять программно (через code_run или спец-инструмент). */
  surface: string;
}

/** Железо и подключённые устройства машины (§ контекст системы). Статика — собирается раз при старте. */
export interface HardwareInfo {
  cpu?: string;
  /** Напр. "8 ядер / 16 потоков". */
  cores?: string;
  /** Имена видеокарт. */
  gpu?: string[];
  /** VRAM основной видяхи человекочитаемо, напр. "16 ГБ" (через nvidia-smi/реестр, не врущий WMI). */
  vram?: string;
  motherboard?: string;
  ramGB?: number;
  disks?: string[];
  /** Модели мониторов (как устройства), напр. "MSI MAG 271QP X28". */
  monitors?: string[];
  /** Звуковые устройства вывода. */
  audio?: string[];
}

export interface SystemProfile {
  os: string;
  defaultBrowser?: BrowserInfo;
  browsers: BrowserInfo[];
  apps: AppInfo[];
  /** Автоматизируемые инструменты (CLI/API), найденные на машине — арсенал «программного пути». */
  tools: ToolCap[];
  /** Конфигурация железа/устройств (CPU/GPU/мать/ОЗУ/диски/мониторы/звук). */
  hardware?: HardwareInfo;
}

interface BrowserSpec {
  id: string;
  name: string;
  /** Префиксы ProgId дефолтного браузера в реестре. */
  progIds: string[];
  /** Кандидаты пути exe (env-шаблоны раскрываются в resolve). */
  exe: string[];
  /** Каталог профиля (env-шаблон). */
  userData: string;
  cdpCapable: boolean;
}

const env = (k: string): string => process.env[k] ?? "";

/** Спеки известных браузеров. Чистые данные — основа маппинга. */
export const BROWSER_SPECS: readonly BrowserSpec[] = [
  {
    id: "chrome", name: "Google Chrome", progIds: ["ChromeHTML"],
    exe: [join(env("ProgramFiles"), "Google\\Chrome\\Application\\chrome.exe"), join(env("ProgramFiles(x86)"), "Google\\Chrome\\Application\\chrome.exe"), join(env("LOCALAPPDATA"), "Google\\Chrome\\Application\\chrome.exe")],
    userData: join(env("LOCALAPPDATA"), "Google\\Chrome\\User Data"), cdpCapable: true,
  },
  {
    id: "edge", name: "Microsoft Edge", progIds: ["MSEdgeHTM", "MSEdgeMHT"],
    exe: [join(env("ProgramFiles(x86)"), "Microsoft\\Edge\\Application\\msedge.exe"), join(env("ProgramFiles"), "Microsoft\\Edge\\Application\\msedge.exe")],
    userData: join(env("LOCALAPPDATA"), "Microsoft\\Edge\\User Data"), cdpCapable: true,
  },
  {
    id: "brave", name: "Brave", progIds: ["BraveHTML", "BraveSSHTM"],
    exe: [join(env("ProgramFiles"), "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), join(env("ProgramFiles(x86)"), "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), join(env("LOCALAPPDATA"), "BraveSoftware\\Brave-Browser\\Application\\brave.exe")],
    userData: join(env("LOCALAPPDATA"), "BraveSoftware\\Brave-Browser\\User Data"), cdpCapable: true,
  },
  {
    id: "yandex", name: "Yandex Browser", progIds: ["YandexHTML", "YandexBrowserHTML"],
    exe: [join(env("LOCALAPPDATA"), "Yandex\\YandexBrowser\\Application\\browser.exe")],
    userData: join(env("LOCALAPPDATA"), "Yandex\\YandexBrowser\\User Data"), cdpCapable: true,
  },
  {
    id: "opera", name: "Opera", progIds: ["OperaStable", "Opera"],
    exe: [join(env("LOCALAPPDATA"), "Programs\\Opera\\opera.exe"), join(env("LOCALAPPDATA"), "Programs\\Opera GX\\opera.exe")],
    userData: join(env("APPDATA"), "Opera Software\\Opera Stable"), cdpCapable: true,
  },
  {
    id: "vivaldi", name: "Vivaldi", progIds: ["VivaldiHTM"],
    exe: [join(env("LOCALAPPDATA"), "Vivaldi\\Application\\vivaldi.exe")],
    userData: join(env("LOCALAPPDATA"), "Vivaldi\\User Data"), cdpCapable: true,
  },
  {
    id: "firefox", name: "Mozilla Firefox", progIds: ["FirefoxURL"],
    exe: [join(env("ProgramFiles"), "Mozilla Firefox\\firefox.exe"), join(env("ProgramFiles(x86)"), "Mozilla Firefox\\firefox.exe")],
    userData: "", cdpCapable: false, // Firefox — не CDP (Marionette), для автоматизации не используем
  },
];

/** ProgId дефолтного браузера → id браузера (чистая). */
export function progIdToBrowserId(progId: string): string | undefined {
  const p = progId.trim();
  for (const spec of BROWSER_SPECS) {
    if (spec.progIds.some((x) => p.toLowerCase().startsWith(x.toLowerCase()))) return spec.id;
  }
  return undefined;
}

/** Собрать BrowserInfo из спеки (резолв exe через existsSync). null если exe нет. */
export function resolveBrowserInfo(id: string, isDefault: boolean): BrowserInfo | null {
  const spec = BROWSER_SPECS.find((s) => s.id === id);
  if (!spec) return null;
  const exe = spec.exe.find((p) => p && existsSync(p));
  if (!exe) return null;
  return { id: spec.id, name: spec.name, exe, userDataDir: spec.userData, cdpCapable: spec.cdpCapable, isDefault };
}

// ── IO: реестр и приложения ───────────────────────────────────

/** Прочитать ProgId дефолтного браузера из реестра (HKCU UserChoice). */
export async function readDefaultBrowserProgId(): Promise<string | undefined> {
  const key = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
  const out = await regQuery(key, "ProgId");
  // Формат строки: "    ProgId    REG_SZ    ChromeHTML"
  const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out);
  return m?.[1];
}

function regQuery(key: string, value: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("reg", ["query", key, "/v", value], { windowsHide: true });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { out += d; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
    setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(out); }, 4000).unref?.();
  });
}

/** Известные приложения (детектируем по присутствию exe). */
const APP_SPECS: ReadonlyArray<{ id: string; name: string; exe: string }> = [
  { id: "telegram", name: "Telegram", exe: join(env("APPDATA"), "Telegram Desktop\\Telegram.exe") },
  { id: "discord", name: "Discord", exe: join(env("LOCALAPPDATA"), "Discord\\Update.exe") },
  { id: "whatsapp", name: "WhatsApp", exe: join(env("LOCALAPPDATA"), "WhatsApp\\WhatsApp.exe") },
  { id: "spotify", name: "Spotify", exe: join(env("APPDATA"), "Spotify\\Spotify.exe") },
  { id: "vlc", name: "VLC", exe: join(env("ProgramFiles"), "VideoLAN\\VLC\\vlc.exe") },
  { id: "word", name: "Microsoft Word", exe: join(env("ProgramFiles"), "Microsoft Office\\root\\Office16\\WINWORD.EXE") },
  { id: "excel", name: "Microsoft Excel", exe: join(env("ProgramFiles"), "Microsoft Office\\root\\Office16\\EXCEL.EXE") },
  { id: "vscode", name: "VS Code", exe: join(env("LOCALAPPDATA"), "Programs\\Microsoft VS Code\\Code.exe") },
  { id: "steam", name: "Steam", exe: join(env("ProgramFiles(x86)"), "Steam\\steam.exe") },
];

/** Найти установленные приложения из APP_SPECS (по наличию exe). */
export function detectApps(): AppInfo[] {
  return APP_SPECS.filter((a) => a.exe && existsSync(a.exe)).map((a) => ({ id: a.id, name: a.name, exe: a.exe }));
}

/**
 * Каталог программно-управляемых инструментов. Детектим по команде на PATH ИЛИ по известному exe;
 * `surface` — подсказка агенту, КАК драйвить (через code_run или спец-инструмент). Это и есть
 * «большое покрытие» БЕЗ хардкода: модель видит реальный арсенал и тянется к программному пути,
 * а не кликает по GUI. Расширять — добавляя строки сюда, а не плодя актуаторы.
 */
interface ToolSpec {
  id: string;
  name: string;
  /** Имя команды для поиска на PATH (без расширения). */
  cmd?: string;
  /** Известные пути exe (если не на PATH). */
  paths?: string[];
  surface: string;
}
const TOOL_SPECS: readonly ToolSpec[] = [
  { id: "ffmpeg", name: "FFmpeg", cmd: "ffmpeg", surface: "видео/аудио (нарезка, конверт, склейка, субтитры) — через code_run; НАДЁЖНЕЕ монтажа кликами" },
  { id: "tesseract", name: "Tesseract OCR", cmd: "tesseract", surface: "распознать текст с картинки/скрина — через code_run (дешевле зрения для чистого текста)" },
  { id: "yt-dlp", name: "yt-dlp", cmd: "yt-dlp", surface: "скачать видео/аудио с YouTube и сотен сайтов — через code_run" },
  { id: "git", name: "Git", cmd: "git", surface: "git (клон/коммит/дифф) — через code_run" },
  { id: "gh", name: "GitHub CLI", cmd: "gh", surface: "GitHub: PR/issues/репозитории — через code_run (gh ...)" },
  { id: "docker", name: "Docker", cmd: "docker", surface: "контейнеры/образы — через code_run" },
  { id: "ollama", name: "Ollama", cmd: "ollama", surface: "ЛОКАЛЬНЫЙ LLM ($0): HTTP http://localhost:11434/api или `ollama run` — через code_run" },
  { id: "blender", name: "Blender", cmd: "blender", surface: "3D headless: `blender -b файл.blend -P скрипт.py` — через code_run" },
  { id: "dotnet", name: ".NET SDK", cmd: "dotnet", surface: "сборка/запуск .NET — через code_run" },
  { id: "psql", name: "PostgreSQL CLI", cmd: "psql", surface: "SQL к Postgres — через code_run (psql)" },
  { id: "obs", name: "OBS Studio", paths: [join(env("ProgramFiles"), "obs-studio\\bin\\64bit\\obs64.exe")], surface: "ПРОГРАММНО через инструмент obs_request (obs-websocket) — стрим/сцены/настройки, НЕ клики" },
];

/** Команда есть на PATH? (проверяем .exe/.cmd/.bat и без расширения). Чистая — exists/pathStr инжектятся. */
export function onPath(cmd: string, pathStr: string, exists: (p: string) => boolean): boolean {
  const dirs = pathStr.split(";").filter(Boolean);
  const cands = [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`, cmd];
  return dirs.some((d) => cands.some((c) => exists(join(d, c))));
}

/** Детект автоматизируемых инструментов (CLI на PATH / известные exe). exists/pathStr инжектятся для теста. */
export function detectAutomationTools(
  exists: (p: string) => boolean = existsSync,
  pathStr: string = process.env.PATH ?? "",
): ToolCap[] {
  const found: ToolCap[] = [];
  for (const t of TOOL_SPECS) {
    const ok = (t.cmd && onPath(t.cmd, pathStr, exists)) || (t.paths?.some((p) => p && exists(p)) ?? false);
    if (ok) found.push({ id: t.id, name: t.name, surface: t.surface });
  }
  return found;
}

/** Список установленных браузеров (любой exe из спеки присутствует). */
export function detectBrowsers(defaultId?: string): BrowserInfo[] {
  const list: BrowserInfo[] = [];
  for (const spec of BROWSER_SPECS) {
    const info = resolveBrowserInfo(spec.id, spec.id === defaultId);
    if (info) list.push(info);
  }
  return list;
}

// ── Железо/устройства (WMI/CIM, §контекст системы) ───────────────

/** Запустить PowerShell-скрипт через -EncodedCommand (без проблем экранирования) и распарсить JSON-вывод. */
export function runPsJson<T>(script: string, timeoutMs = 12000): Promise<T | null> {
  return new Promise((resolve) => {
    // Префикс UTF-8: имена мониторов/звука/«ГБ» кириллицей иначе бьются (cp866 → мохибейк).
    const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n${script}`;
    const encoded = Buffer.from(full, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      out += d;
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim()) as T);
      } catch {
        resolve(null);
      }
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* */
      }
      resolve(null);
    }, timeoutMs).unref?.();
  });
}

/** WMI/CIM-скрипт: CPU/GPU/мать/ОЗУ/диски/мониторы/звук + точный VRAM через nvidia-smi (WMI AdapterRAM врёт >4ГБ). */
const HARDWARE_PS = `$ErrorActionPreference='SilentlyContinue'
$cs=Get-CimInstance Win32_ComputerSystem
$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu=@(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Name -notmatch 'Citrix|Remote|Basic Display|Mirror|Virtual|Parsec|DisplayLink Soft' } | ForEach-Object { $_.Name })
$bb=Get-CimInstance Win32_BaseBoard
$ramGB=[math]::Round($cs.TotalPhysicalMemory/1GB,0)
$disks=@(Get-CimInstance Win32_DiskDrive | Where-Object { $_.Size } | ForEach-Object { ('{0} {1}GB' -f $_.Model.Trim(), [math]::Round($_.Size/1GB,0)) })
$mons=@(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | ForEach-Object {
  $mfg=(($_.ManufacturerName | Where-Object { $_ -gt 0 }) | ForEach-Object { [char]$_ }) -join ''
  $nm=(($_.UserFriendlyName | Where-Object { $_ -gt 0 }) | ForEach-Object { [char]$_ }) -join ''
  ("$mfg $nm").Trim()
} | Where-Object { $_ })
$audio=@(Get-CimInstance Win32_SoundDevice | Where-Object { $_.Status -eq 'OK' } | Select-Object -ExpandProperty Name -Unique)
$vram=''
$smi=& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
if($smi){ $vram=('{0} ГБ' -f [math]::Round((($smi | Select-Object -First 1) -as [double])/1024,0)) }
[ordered]@{ cpu=$cpu.Name.Trim(); cores=('{0} ядер / {1} потоков' -f $cpu.NumberOfCores,$cpu.NumberOfLogicalProcessors); gpu=$gpu; vram=$vram; motherboard=(('{0} {1}' -f $bb.Manufacturer,$bb.Product).Trim()); ramGB=$ramGB; disks=$disks; monitors=$mons; audio=$audio } | ConvertTo-Json -Compress -Depth 4`;

/** Нормализовать в массив строк (PowerShell сериализует одиночный элемент не как массив). */
function asArr(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v];
  return undefined;
}

/** Собрать конфигурацию железа/устройств (IO, через WMI/nvidia-smi). Раз при старте; ошибка → undefined. */
export async function detectHardware(): Promise<HardwareInfo | undefined> {
  const raw = await runPsJson<Record<string, unknown>>(HARDWARE_PS);
  if (!raw) return undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    cpu: str(raw.cpu),
    cores: str(raw.cores),
    gpu: asArr(raw.gpu),
    vram: str(raw.vram),
    motherboard: str(raw.motherboard),
    ramGB: num(raw.ramGB),
    disks: asArr(raw.disks),
    monitors: asArr(raw.monitors),
    audio: asArr(raw.audio),
  };
}

/** Краткая строка конфигурации железа для промпта (чистая — для теста). */
export function formatHardwareSummary(h: HardwareInfo): string {
  const parts: string[] = [];
  if (h.cpu) parts.push(`CPU: ${h.cpu}${h.cores ? ` (${h.cores})` : ""}`);
  if (h.gpu?.length) parts.push(`GPU: ${h.gpu.join(", ")}${h.vram ? ` ${h.vram}` : ""}`);
  if (h.ramGB) parts.push(`ОЗУ: ${h.ramGB} ГБ`);
  if (h.motherboard) parts.push(`мать: ${h.motherboard}`);
  if (h.disks?.length) parts.push(`диски: ${h.disks.join(", ")}`);
  if (h.monitors?.length) parts.push(`мониторы: ${h.monitors.join(", ")}`);
  if (h.audio?.length) parts.push(`звук: ${h.audio.join(", ")}`);
  return parts.length ? `Железо ПК: ${parts.join("; ")}.` : "";
}

/** Полный профиль окружения (для агента и браузерной автоматизации). */
export async function buildSystemProfile(): Promise<SystemProfile> {
  const progId = await readDefaultBrowserProgId();
  const defaultId = progId ? progIdToBrowserId(progId) : undefined;
  const browsers = detectBrowsers(defaultId);
  const defaultBrowser = browsers.find((b) => b.isDefault) ?? browsers[0];
  // Железо — параллельно (WMI медленный ~1-3с), не блокируем браузерный профиль.
  const hardware = await detectHardware();
  return { os: `${process.platform} ${process.arch}`, defaultBrowser, browsers, apps: detectApps(), tools: detectAutomationTools(), hardware };
}

/**
 * Браузер для CDP-автоматизации: дефолтный, если он Chromium; иначе первый установленный
 * Chromium-браузер; иначе undefined (диспетчер откатится на простой запуск URL).
 */
export async function resolveAutomationBrowser(): Promise<BrowserInfo | undefined> {
  const profile = await buildSystemProfile();
  if (profile.defaultBrowser?.cdpCapable) return profile.defaultBrowser;
  return profile.browsers.find((b) => b.cdpCapable);
}

/** Краткая сводка окружения для системного промпта агента (чистая). */
export function formatProfileSummary(p: SystemProfile): string {
  const parts: string[] = [];
  if (p.defaultBrowser) {
    parts.push(`браузер по умолчанию — ${p.defaultBrowser.name}${p.defaultBrowser.cdpCapable ? "" : " (без авто-управления)"}`);
  }
  const others = p.browsers.filter((b) => !b.isDefault).map((b) => b.name);
  if (others.length) parts.push(`ещё установлены браузеры: ${others.join(", ")}`);
  if (p.apps.length) parts.push(`установленные приложения: ${p.apps.map((a) => a.name).join(", ")}`);
  let summary = parts.length ? `${parts.join("; ")}.` : "";
  // Арсенал «программного пути» (§ правило v21: API/CLI первым, GUI последним). Перечисляем КАК
  // драйвить — чтобы модель тянулась к надёжному пути, а не кликала по интерфейсу.
  const tools = p.tools ?? [];
  if (tools.length) {
    summary += `\nПрограммно доступно на этой машине (используй ЭТО, а не клики по GUI): ${tools
      .map((t) => `${t.name} — ${t.surface}`)
      .join("; ")}.`;
  }
  // Конфигурация железа/устройств — чтобы Джарвис знал, на чём работает (проц/видяха/мать/мониторы/звук).
  if (p.hardware) {
    const hw = formatHardwareSummary(p.hardware);
    if (hw) summary += `\n${hw}`;
  }
  return summary;
}
