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
import { existsSync, readdirSync } from "node:fs";
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
  /** Установленные Steam-игры (имена из appmanifest, кап 12) — А7, ревью 2026-07-10. */
  games?: string[];
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
  /**
   * Известные пути exe (если не на PATH). Допускается ОДИН `*`-сегмент — под версионные каталоги
   * («…\Blender Foundation\*\blender.exe»): хардкод версии протухает при первом же обновлении.
   */
  paths?: string[];
  surface: string;
}
const TOOL_SPECS: readonly ToolSpec[] = [
  { id: "ffmpeg", name: "FFmpeg", cmd: "ffmpeg", surface: "видео/аудио (нарезка, конверт, склейка, субтитры) — через code_run; НАДЁЖНЕЕ монтажа кликами" },
  { id: "tesseract", name: "Tesseract OCR", cmd: "tesseract", surface: "распознать текст с картинки/скрина — через code_run (дешевле зрения для чистого текста)" },
  { id: "yt-dlp", name: "yt-dlp", cmd: "yt-dlp", surface: "скачать видео/аудио с YouTube и сотен сайтов — через code_run" },
  { id: "git", name: "Git", cmd: "git", surface: "git (клон/коммит/дифф; поиск по коду — git grep -n) — через code_run с cwd" },
  { id: "gh", name: "GitHub CLI", cmd: "gh", surface: "GitHub: PR/issues/репозитории — через code_run (gh ...)" },
  { id: "docker", name: "Docker", cmd: "docker", surface: "контейнеры/образы — через code_run" },
  { id: "ollama", name: "Ollama", cmd: "ollama", surface: "ЛОКАЛЬНЫЙ LLM ($0): HTTP http://localhost:11434/api или `ollama run` — через code_run" },
  // 🔴 Blender был НЕВИДИМ (2026-09-01): установщик не кладёт exe на PATH и оставляет пустой
  // DisplayIcon в реестре — значит ни детект PATH, ни инвентарь установленного его не находили, и
  // app_channels отвечал «канала нет» про программу, которая на машине ЕСТЬ. Путь версионный
  // («Blender 5.1»), поэтому glob: хардкод версии протух бы на первом обновлении.
  {
    id: "blender",
    name: "Blender",
    cmd: "blender",
    paths: [join(env("ProgramFiles"), "Blender Foundation\\*\\blender.exe")],
    surface: "3D headless: `blender -b файл.blend --python-exit-code 1 -P скрипт.py` — через code_run; exe обычно НЕ на PATH, зови по полному пути",
  },
  { id: "dotnet", name: ".NET SDK", cmd: "dotnet", surface: "сборка/запуск .NET — через code_run" },
  { id: "psql", name: "PostgreSQL CLI", cmd: "psql", surface: "SQL к Postgres — через code_run (psql)" },
  // 🔴 Добавлено адверс-ревью 2026-09-01 (HIGH). Реестр каналов уже нёс рецепты под эти команды, но
  // клиент их не детектил — а матч рецепта с `cmd` идёт по ДЕТЕКТИРОВАННОМУ списку. Итог был хуже,
  // чем отсутствие рецепта: app_channels уверенно отвечал «канала нет — остаётся GUI» про питон,
  // видеокарту и PDF, которые на машине ЕСТЬ, и разворачивал модель в самый дорогой пиксельный путь.
  { id: "python", name: "Python", cmd: "python", surface: "документы БЕЗ Office (openpyxl/python-docx/python-pptx — единственный путь к .pptx), PDF (PyMuPDF), любые скрипты — через code_run" },
  { id: "nvidia-smi", name: "NVIDIA GPU", cmd: "nvidia-smi", surface: "температура/загрузка/память видеокарты и что её грузит — через code_run (--query-gpu ... --format=csv); ЧТЕНИЕ надёжно, управление на GeForce почти нет" },
  { id: "7z", name: "7-Zip", cmd: "7z", surface: "архивы: собрать/распаковать/ПРОВЕРИТЬ целостность (7z t) — через code_run" },
  { id: "magick", name: "ImageMagick", cmd: "magick", surface: "картинки пакетно: resize/crop/конверт/склейка + identify для сверки размеров — через code_run" },
  { id: "pandoc", name: "pandoc", cmd: "pandoc", surface: "конверсия документов docx/md/html/odt (честный код возврата, в отличие от soffice) — через code_run" },
  { id: "pdftotext", name: "poppler (PDF)", cmd: "pdftotext", surface: "текст из PDF (-layout); ПУСТО при непустом файле = скана без текстового слоя → дальше OCR, а не повтор — через code_run" },
  { id: "qpdf", name: "qpdf", cmd: "qpdf", surface: "PDF: --check (верификатор для любых PDF-операций), --show-npages, склейка/разбор, снять пароль — через code_run" },
  { id: "ocrmypdf", name: "OCRmyPDF", cmd: "ocrmypdf", surface: "OCR-слой в PDF (-l rus+eng --sidecar) — через code_run; для ЭКРАНА не годится, там screen_read_text" },
  { id: "es", name: "Everything (поиск файлов)", cmd: "es", surface: "мгновенный поиск файлов по всем NTFS-дискам (на порядки быстрее обхода дерева) — через code_run; 'IPC error' = служба не запущена, это ошибка канала, а не 'не найдено'" },
  { id: "obs", name: "OBS Studio", paths: [join(env("ProgramFiles"), "obs-studio\\bin\\64bit\\obs64.exe")], surface: "ПРОГРАММНО через инструмент obs_request (obs-websocket) — стрим/сцены/настройки, НЕ клики" },
  // OfficeCLI: правка ФАЙЛОВ Office на диске БЕЗ установленного MS Office — основной путь для .pptx
  // (дедик-актуатора нет), headless-фолбэк Word/Excel. Честность (адверс-ревью 2026-07-23):
  // (1) office_word/office_excel ТОЖЕ правят файл с диска собственным headless-COM — «открытый документ»
  // они НЕ правят (attach к живому инстансу в системе нет); файл, открытый в видимом Office, залочен —
  // файловым путём не править вообще. (2) Сверка исхода — ТЕКСТОВЫЙ readback `get --json`: PNG-рендер
  // (`view … screenshot`) агент увидеть не может (канала файл→vision нет), рендер — лишь показ юзеру.
  { id: "officecli", name: "OfficeCLI", cmd: "officecli", surface: "правка ФАЙЛОВ .docx/.xlsx/.pptx БЕЗ MS Office: `officecli create/get/set/add <файл>` (пути /slide[1]/shape[1], --json) — через code_run; сверка исхода — перечитай `officecli get --json`. Для .pptx это основной путь (актуатора нет; фолбэк python-pptx). Файл, открытый сейчас в Office, НЕ правь (залочен); живой документ — только COM через code_run" },
];

/** Команда есть на PATH? (проверяем .exe/.cmd/.bat и без расширения). Чистая — exists/pathStr инжектятся. */
export function onPath(cmd: string, pathStr: string, exists: (p: string) => boolean): boolean {
  const dirs = pathStr.split(";").filter(Boolean);
  const cands = [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`, cmd];
  return dirs.some((d) => cands.some((c) => exists(join(d, c))));
}

/** Защита от гигантского каталога: разворачиваем glob по первым N записям. */
const GLOB_SCAN_CAP = 200;

/**
 * Развернуть путь с ОДНИМ `*`-сегментом до реально существующего файла («…\Blender Foundation\*\
 * blender.exe» → «…\Blender Foundation\Blender 5.1\blender.exe»). Возвращает найденный путь либо
 * undefined. ЧИСТАЯ — exists/listDir инжектятся.
 *
 * Почему glob: версия живёт в ИМЕНИ каталога, и хардкод «Blender 5.1» протухнет на первом обновлении,
 * снова сделав программу невидимой — то есть вернёт ровно тот дефект, ради которого это писалось.
 */
export function resolveGlobPath(
  pattern: string,
  exists: (p: string) => boolean,
  listDir: (dir: string) => string[],
): string | undefined {
  if (!pattern.includes("*")) return exists(pattern) ? pattern : undefined;
  const parts = pattern.split(/[\\/]/);
  const idx = parts.findIndex((p) => p.includes("*"));
  // Поддержан РОВНО один подстановочный сегмент: больше — честно не умеем, молча угадывать нельзя.
  if (idx <= 0 || parts.slice(idx + 1).some((p) => p.includes("*"))) return undefined;
  const parent = parts.slice(0, idx).join("\\");
  const rest = parts.slice(idx + 1);
  const seg = parts[idx]!;
  const re = new RegExp(`^${seg.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  for (const entry of listDir(parent).slice(0, GLOB_SCAN_CAP)) {
    if (!re.test(entry)) continue;
    const full = [parent, entry, ...rest].join("\\");
    if (exists(full)) return full;
  }
  return undefined;
}

/** Список имён в каталоге; недоступный каталог — пустой список (детект не должен падать). */
function safeListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Детект автоматизируемых инструментов (CLI на PATH / известные exe). exists/pathStr инжектятся для теста. */
export function detectAutomationTools(
  exists: (p: string) => boolean = existsSync,
  pathStr: string = process.env.PATH ?? "",
  listDir: (dir: string) => string[] = safeListDir,
): ToolCap[] {
  const found: ToolCap[] = [];
  for (const t of TOOL_SPECS) {
    if (t.cmd && onPath(t.cmd, pathStr, exists)) {
      found.push({ id: t.id, name: t.name, surface: t.surface });
      continue;
    }
    // Нашли по известному пути, а НЕ на PATH — значит голая команда в code_run не запустится.
    // Отдаём модели фактический путь: иначе surface обещает то, чего сделать нельзя (закон честности).
    const hit = t.paths?.map((p) => resolveGlobPath(p, exists, listDir)).find(Boolean);
    if (hit) found.push({ id: t.id, name: t.name, surface: `${t.surface}; полный путь: ${hit}` });
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
// Steam-библиотека (А7, ревью 2026-07-10): libraryfolders.vdf → appmanifest_*.acf → имена игр.
// Раньше env знал только 9 хардкодных APP_SPECS — Дота, в которую владелец играет каждый вечер,
// в окружении отсутствовала как понятие. Тот же источник истины, что у app-resolve (скан манифестов).
const STEAM_GAMES_PS = `$junk='redistributable|runtime|proton|steamworks common|dedicated server|sdk|soundtrack'
$names=New-Object System.Collections.ArrayList
$sp=(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath
if($sp){
  $vdf=Join-Path $sp 'steamapps\\libraryfolders.vdf'
  $libs=@($sp)
  if(Test-Path $vdf){ $libs += ((Select-String -Path $vdf -Pattern '"path"\\s+"([^"]+)"' -AllMatches).Matches | ForEach-Object { $_.Groups[1].Value -replace '\\\\\\\\','\\' }) }
  foreach($l in ($libs | Select-Object -Unique)){
    $sa=Join-Path $l 'steamapps'; if(-not(Test-Path $sa)){continue}
    Get-ChildItem $sa -Filter 'appmanifest_*.acf' -ErrorAction SilentlyContinue | ForEach-Object {
      $m=Get-Content $_.FullName -Encoding UTF8 | Select-String -Pattern '"name"\\s+"([^"]+)"' | Select-Object -First 1
      if($m){ $nm=$m.Matches[0].Groups[1].Value; if($nm -and ($nm -notmatch $junk)){ [void]$names.Add($nm) } }
    }
  }
}
ConvertTo-Json -Compress -InputObject @($names | Select-Object -Unique | Select-Object -First 12)`;

/** Установленные Steam-игры (имена из манифестов, кап 12). Ошибка/нет Steam → []. */
export async function detectSteamGames(): Promise<string[]> {
  const raw = await runPsJson<string[]>(STEAM_GAMES_PS, 8000);
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

export async function buildSystemProfile(): Promise<SystemProfile> {
  const progId = await readDefaultBrowserProgId();
  const defaultId = progId ? progIdToBrowserId(progId) : undefined;
  const browsers = detectBrowsers(defaultId);
  const defaultBrowser = browsers.find((b) => b.isDefault) ?? browsers[0];
  // Железо и Steam-игры — параллельно (WMI/скан медленные), не блокируем браузерный профиль.
  const [hardware, games] = await Promise.all([detectHardware(), detectSteamGames()]);
  return { os: `${process.platform} ${process.arch}`, defaultBrowser, browsers, apps: detectApps(), tools: detectAutomationTools(), hardware, games };
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
  if (p.games?.length) parts.push(`Steam-игры: ${p.games.join(", ")}`);
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

// ── РЕАЛЬНЫЙ ИНВЕНТАРЬ УСТАНОВЛЕННОГО (реестр программных каналов, 2026-09-01) ──────────────

/**
 * 🔴 Зачем (форензика логов): список приложений был ЗАХАРДКОЖЕН — 9 путей (APP_SPECS), из них на
 * машине нашлось 3. Всё остальное для Джарвиса не существовало, и он ходил кликами там, где у
 * программы есть команда или протокол. Живая проверка ЭТОЙ машины: реально установлено 71
 * приложение и зарегистрировано 96 URI-схем.
 *
 * Здесь — ФАКТЫ о машине (что стоит, какие протоколы зарегистрированы). ЗНАНИЕ о том, как этим
 * управлять программно, живёт на сервере (`brain/app-channels.ts`) и правится без пересборки клиента.
 */
export interface InstalledAppInfo {
  name: string;
  /** Имя exe без пути, нижний регистр — ключ сопоставления с рецептом. */
  exe?: string;
  /** Зарегистрированная URI-схема без двоеточия (tg, spotify, steam…). */
  uri?: string;
}

/** Мусор в списке установленного: обновления, рантаймы, драйверы — управлять там нечем. */
const INSTALL_JUNK_RE =
  /(redistributable|runtime|driver|update for|hotfix|security update|language pack|\bsdk\b|microsoft visual c\+\+|\.net framework|software development kit)/i;

/** Кап списка: он идёт в client.env (не в промпт), но и там не должен быть безразмерным. */
const INSTALLED_CAP = 400;
/**
 * Бюджет под URI-схемы. На живой машине их 222 — без отдельного лимита они съедали ВЕСЬ кап и
 * приложения не доезжали вовсе (обратный перекос к прежнему, где схемы не доезжали). Рецепты
 * матчатся и по exe (приложения), и по протоколу — нужны обе половины.
 */
const SCHEME_CAP = 250;

/** Схемы, которые не несут информации о приложении. */
const GENERIC_SCHEMES = new Set(["http", "https", "mailto", "file", "ftp", "about", "javascript"]);

/**
 * PS-инвентарь → JSON. Идёт через runPsJson (-EncodedCommand, base64 UTF-16LE), поэтому проблем с
 * экранированием и кодировкой нет. ASCII-only по правилу проекта.
 */
const INVENTORY_PS = String.raw`
$ErrorActionPreference='SilentlyContinue'
$apps=@()
$keys=@(
 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
foreach($k in $keys){
  foreach($p in (Get-ItemProperty $k)){
    if(-not $p.DisplayName){continue}
    if($p.SystemComponent -eq 1){continue}
    $icon=''
    if($p.DisplayIcon){ $icon=($p.DisplayIcon -split ',')[0] }
    $apps += [pscustomobject]@{ name=[string]$p.DisplayName; icon=[string]$icon }
  }
}
$uris=@()
# ⚠️ ЗАМЕРЕНО НА ЭТОЙ МАШИНЕ: перебор HKCR провайдером PowerShell (Get-ChildItem Registry::…) —
# 46 СЕКУНД на 6344 ключа, инвентарь не укладывался ни в какой разумный таймаут. Прямой .NET-API
# отдаёт те же имена за 39мс, а проверка 726 кандидатов на 'URL Protocol' — ещё за 41мс.
$root=[Microsoft.Win32.Registry]::ClassesRoot
foreach($n in $root.GetSubKeyNames()){
  if($n -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$'){continue}
  if($n.Contains('.')){continue}
  $k=$root.OpenSubKey($n)
  if(-not $k){continue}
  if($k.GetValue('URL Protocol') -eq $null){continue}
  $c=$root.OpenSubKey($n + '\shell\open\command')
  $cmd=''
  if($c){ $cmd=[string]$c.GetValue('') }
  $uris += [pscustomobject]@{ scheme=[string]$n; cmd=$cmd }
}
[pscustomobject]@{ apps=$apps; uris=$uris } | ConvertTo-Json -Depth 3 -Compress
`;

/** Сырой ответ PS-инвентаря. */
interface RawInventory {
  apps?: Array<{ name?: string; icon?: string }>;
  uris?: Array<{ scheme?: string; cmd?: string }>;
}

/**
 * Имя exe без пути, нижним регистром (в реестре пути бывают в кавычках и с аргументами).
 *
 * ⚠️ Пустая строка — ЧЕСТНЫЙ ответ «бинарь неизвестен». DisplayIcon сплошь и рядом указывает не на
 * приложение: у Git это `.ico`, у Word — `osetup.dll`, у Google Play Games — `uninstaller.exe`.
 * Неверный ключ сопоставления хуже отсутствующего: он привязал бы рецепт к чужой программе, а
 * «uninstaller.exe» — ровно тот класс путаницы, из-за которого Джарвис уже запускал деинсталлятор.
 * Такие записи матчатся по имени и протоколу.
 */
export function exeLeaf(raw: string): string {
  return exeLeafFrom(raw).leaf;
}

/** Служебные бинари, которые НЕЛЬЗЯ считать «приложением» (мы уже запускали деинсталлятор по ошибке). */
const SERVICE_BINARY = /(^|[-_.])(unins\w*|uninstall\w*|setup|installer|maintenancetool|vc_redist)\.exe$/i;

/**
 * Полный путь и листовое имя бинаря из строки реестра. ЧИСТАЯ функция.
 *
 * ⚠️ Адверс-ревью 2026-09-01: прежняя версия резала аргументы по «пробел + дефис/слэш», а у
 * подавляющего большинства обработчиков протоколов аргумент — плейсхолдер `"%1"` БЕЗ ключа
 * (`"C:\…\App.exe" "%1"`). Хвост оставался приклеенным, строка не оканчивалась на .exe, и бинарь
 * терялся — на этой машине так выпадало больше половины URI-схем. Теперь не «режем аргументы», а
 * ИЩЕМ первый токен, оканчивающийся на .exe.
 */
export function exeLeafFrom(raw: string): { path: string; leaf: string } {
  const cleaned = String(raw || "")
    .replace(/%[0-9A-Za-z*]/g, " ") // плейсхолдеры %1, %V, %*
    .replace(/"/g, " ")
    .trim();
  const m = /^(.*?\.exe)(?=$|\s)/i.exec(cleaned) ?? /([^\s]*\.exe)/i.exec(cleaned);
  const full = (m?.[1] ?? "").trim();
  if (!full) return { path: "", leaf: "" };
  const leaf = (full.split(/[\\/]/).pop() ?? full).trim().toLowerCase();
  if (!leaf.endsWith(".exe") || SERVICE_BINARY.test(leaf)) return { path: "", leaf: "" };
  return { path: full.toLowerCase(), leaf };
}

/**
 * Свести инвентарь в список приложений. ЧИСТАЯ функция — тестируется без PowerShell.
 * URI-схема привязывается к приложению по exe: рецепт матчится и по протоколу, и по бинарю.
 */
export function buildInstalled(raw: RawInventory): InstalledAppInfo[] {
  // ПРОТОКОЛЫ ИДУТ ПЕРВЫМИ (адверс-ревью): раньше цикл по приложениям делал ранний `return` при
  // достижении капа, и на машине со 120+ программами ВСЕ протокольные каналы просто не доезжали —
  // хотя именно они и есть каналы (ms-settings:, tg:, steam:). Их единицы, приложения добираются потом.
  const out: InstalledAppInfo[] = [];
  const schemeByPath = new Map<string, string>();
  const seenScheme = new Set<string>();
  for (const u of raw.uris ?? []) {
    const scheme = (u.scheme ?? "").trim().toLowerCase();
    if (!scheme || GENERIC_SCHEMES.has(scheme) || seenScheme.has(scheme)) continue;
    seenScheme.add(scheme);
    const { path, leaf } = exeLeafFrom(u.cmd ?? "");
    // Привязка схемы к приложению — по ПОЛНОМУ пути, а не по листу: launcher.exe/update.exe/app.exe
    // встречаются у разных программ, и по листу чужой протокол приклеивался к чужой программе.
    if (path && !schemeByPath.has(path)) schemeByPath.set(path, scheme);
    // ⚠️ Схема БЕЗ команды тоже канал: у UWP-обработчиков (ms-settings, ms-photos) shell\open\command
    // пуст, а browser_open{'ms-settings:sound'} исполняется шеллом. Раньше такие выбрасывались —
    // и рецепт «Windows: настройки» не мог сматчиться НИ НА ОДНОЙ машине.
    out.push({ name: `${scheme}:`, ...(leaf ? { exe: leaf } : {}), uri: scheme });
    if (out.length >= SCHEME_CAP) break;
  }

  const seenName = new Set<string>();
  for (const a of raw.apps ?? []) {
    const name = (a.name ?? "").trim();
    if (!name || INSTALL_JUNK_RE.test(name) || seenName.has(name)) continue;
    seenName.add(name);
    const { path, leaf } = exeLeafFrom(a.icon ?? "");
    const uri = path ? schemeByPath.get(path) : undefined;
    out.push({ name, ...(leaf ? { exe: leaf } : {}), ...(uri ? { uri } : {}) });
    if (out.length >= INSTALLED_CAP) break; // именно break: протоколы уже добавлены выше
  }
  return out;
}

/** Перечислить установленное (реестр Windows). Пусто при любом сбое — честная деградация. */
export async function detectInstalledApps(): Promise<InstalledAppInfo[]> {
  if (process.platform !== "win32") return [];
  const raw = await runPsJson<RawInventory>(INVENTORY_PS, 20000);
  return raw ? buildInstalled(raw) : [];
}
