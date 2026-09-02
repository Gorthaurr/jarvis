/**
 * РЕЕСТР ПРОГРАММНЫХ КАНАЛОВ: «у этого приложения есть API — не кликай».
 *
 * 🔴 ЗАЧЕМ (форензика логов + исследование Windows-агентов, 2026-09-01):
 * — «Карта компьютера — хардкод-список из 9 приложений, нашлось 3. Всё остальное для Джарвиса не
 *   существует» — он шёл кликами там, где у программы есть команда/протокол/API.
 * — Измерено у других: добавление программных операций рядом с GUI даёт +3…+14 п.п. успеха и до
 *   −58% шагов, причём выигрыш ТЕМ БОЛЬШЕ, чем дешевле модель. Наш дефолт — Sonnet, то есть рычаг прямой.
 * — Пиксельный путь у нас же самый дорогой и самый ненадёжный: screen_capture — 156 вызовов (первое
 *   место среди инструментов), задачи со скриншотами дают 76% успеха против 88% у остальных.
 *
 * УСТРОЙСТВО. Знание (рецепты) живёт ЗДЕСЬ, на сервере: правится без пересборки клиента. Факты о
 * машине приходят с клиента (`ClientEnv.installed` — что реально установлено, какие URI-схемы
 * зарегистрированы, что лежит на PATH). Матчинг — по имени exe (без пути) и по URI-схеме.
 *
 * ЧЕСТНОСТЬ — часть контракта рецепта, а не примечание:
 * — `verify` обязателен: канал без способа СВЕРИТЬ исход порождает ложное «готово» ровно так же,
 *   как слепой клик. Рецепт без сверки в таблицу не берём.
 * — `limits` обязателен: модель не должна обещать владельцу того, чего канал не умеет.
 * — Канала нет (`channel: "none"`) — это ТОЖЕ запись: она экономит попытки и честно отправляет в GUI.
 *
 * В ПРОМПТ каталог целиком НЕ уходит: в паспорте возможностей — одна строка со счётчиком, детали
 * модель берёт инструментом `app_channels` по требованию (§15 — та же логика, что у холодных схем).
 */

/** Вид программного канала, по убыванию предпочтительности. */
import { foldName, transliterate } from "@jarvis/shared";

export type ChannelKind = "cli" | "uri" | "http" | "com" | "websocket" | "config" | "hotkey" | "none";

export interface ChannelRecipe {
  /** Человеческое имя приложения. */
  app: string;
  /** Имена exe (без пути, нижний регистр) — по ним матчим установленное. */
  exe?: string[];
  /** URI-схемы (без двоеточия) — второй способ узнать приложение. */
  uri?: string[];
  /** Команда на PATH — третий способ (и сам по себе канал). */
  cmd?: string;
  /**
   * Русские написания, по которым владелец зовёт приложение. Транслитерация — RECALL, а не
   * исправление: «стим» даёт «stim», до «steam» это дистанция 2. Алиас точнее любой эвристики.
   */
  aliases?: string[];
  /**
   * ВСТРОЕННАЯ утилита Windows (powercfg, schtasks, netsh, clip, powershell). Её нет ни в списке
   * установленного, ни в детекте PATH-команд — но она есть всегда. Без этого флага рецепты
   * системного домена были недостижимы в принципе (адверс-ревью 2026-09-01).
   */
  builtin?: boolean;
  /**
   * СЕТЕВОЙ СЕРВИС: локально ничего не установлено (курсы ЦБ, биржа, погода, push на телефон), но канал есть
   * всегда, пока есть сеть. Матчить не по чему — как и встроенные утилиты, такие рецепты подсеваются сами.
   * Отдельный флаг, а не builtin: врать в декларации нельзя, это НЕ часть Windows, и требования у них свои
   * (у половины — разовый ключ или ссылка, заводит владелец руками; см. limits каждого).
   */
  service?: true;
  /**
   * Канал требует РАЗОВОЙ настройки руками владельца (ключ, токен, секретная ссылка, приложение на
   * телефоне) — и её ещё могло не быть. Такой сервис НЕ называется в паспорте среди готовых:
   * адверс-ревью поймало прямое самопротиворечие — строка каналов объявляла «Т-Инвестиции» доступными
   * рядом со строкой «Тинькофф: токена нет — не предлагай». Здесь пишем, ЧТО именно завести.
   */
  needsSetup?: string;
  kind: ChannelKind;
  /** КАК драйвить: конкретная команда/URI/endpoint. Идёт модели дословно. */
  howTo: string;
  /** Как программно СВЕРИТЬ исход (readback). Без этого рецепт не берём. */
  verify: string;
  /** Чего канал НЕ умеет — чтобы не обещать лишнего. */
  limits: string;
}

/** Что клиент нашёл на машине. */
export interface InstalledApp {
  name: string;
  /** Имя exe без пути (нижний регистр), если известно. */
  exe?: string;
  /** Зарегистрированная URI-схема (без двоеточия), если есть. */
  uri?: string;
  /** Лежит ли одноимённая команда на PATH. */
  cli?: boolean;
}

/**
 * Рецепты. Пополняется строкой — НЕ новым актуатором (принцип проекта: даём модели знание и общий
 * инструмент, а не хардкод под сценарий).
 */
export const CHANNEL_RECIPES: readonly ChannelRecipe[] = [
  {
    app: "Windows: настройки",
    aliases: ["настройки", "параметры", "виндовс"],
    uri: ["ms-settings"],
    exe: ["systemsettings.exe"],
    kind: "uri",
    howTo:
      "Открыть страницу настроек напрямую: app_launch{app:\"ms-settings:<страница>\"} — резолвер клиента принимает URI " +
      "как цель и активирует протокол. 🔴 НЕ browser_open: он пропускает ТОЛЬКО http(s), любая другая схема отвергается " +
      "SSRF-гардом — это гарантированный отказ, а не «иногда не срабатывает». " +
      "Проверенные страницы: sound, sound-devices, apps-volume, display, nightlight, network-status, network-vpn, " +
      "network-wifisettings, powersleep, clipboard, bluetooth, windowsupdate.",
    verify:
      "URI НЕ говорит, какая страница открылась: факт окна — window_list (процесс SystemSettings). " +
      "САМО значение настройки читать программно (powercfg/netsh/PowerShell через code_run), а не глазами.",
    limits: "Только ОТКРЫВАЕТ страницу для человека — ничего не читает и не меняет. Изменение — powercfg/netsh/реестр.",
  },
  {
    app: "Windows: питание и сон",
    exe: ["powercfg.exe"],
    cmd: "powercfg",
    builtin: true,
    kind: "cli",
    howTo:
      "code_run: powercfg /getactivescheme; powercfg /setactive <GUID|SCHEME_BALANCED|SCHEME_MAX>; " +
      "powercfg /change monitor-timeout-ac <мин>; powercfg /change standby-timeout-ac 0 (0 = никогда); powercfg /a.",
    verify: "powercfg /getactivescheme содержит нужный GUID; powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE — фактический таймаут.",
    limits: "/requests, /energy, /systempowerreport требуют админа. Сам не усыпляет и не выключает — это system_power.",
  },
  {
    app: "Windows: планировщик заданий",
    exe: ["schtasks.exe"],
    cmd: "schtasks",
    builtin: true,
    kind: "cli",
    howTo:
      "code_run (PowerShell): Register-ScheduledTask -TaskName «Имя» -Action (New-ScheduledTaskAction -Execute powershell.exe " +
      "-Argument '-NoProfile -File <скрипт>') -Trigger (New-ScheduledTaskTrigger -Daily -At 9:00).",
    verify: "Get-ScheduledTask -TaskName «Имя» → State 'Ready'; реальное срабатывание — Get-ScheduledTaskInfo: LastTaskResult 0.",
    limits:
      "SYSTEM/-RunLevel Highest требуют админа. Это для того, что должно пережить перезагрузку; обычные напоминания " +
      "владельцу Джарвис делает сам (set_reminder), а не планировщиком.",
  },
  {
    app: "Windows: буфер обмена",
    aliases: ["буфер", "буфера", "клипборд"],
    exe: ["clip.exe"],
    cmd: "clip",
    builtin: true,
    kind: "cli",
    howTo:
      "code_run: Get-Clipboard -Raw (текст), Set-Clipboard -Value «текст», Get-Clipboard -Format FileDropList (файлы), " +
      "Get-Clipboard -Format Image (картинка → .Save(путь)).",
    verify: "После записи: (Get-Clipboard -Raw) -eq «то, что клали» — строгое сравнение.",
    limits:
      "Буфер ОБЩИЙ с владельцем: запись затирает скопированное им — предупреждай. В PowerShell 5.1 положить картинку нечем.",
  },
  {
    app: "Windows: сеть и Wi-Fi",
    exe: ["netsh.exe"],
    cmd: "netsh",
    builtin: true,
    kind: "cli",
    howTo:
      "code_run: netsh interface show interface; netsh wlan show interfaces (текущая сеть/сигнал); netsh wlan show profiles; " +
      "netsh interface ip show config; ipconfig /flushdns. Смена адаптеров/DNS — netsh interface ip set ...",
    verify: "Тем же netsh перечитать состояние (show), а не по факту «команда не ругнулась».",
    limits: "Изменение конфигурации адаптеров и брандмауэра требует админа. VPN-клиенты со своим протоколом netsh не видит.",
  },
  {
    app: "Steam",
    aliases: ["стим", "стиме", "стима"],
    exe: ["steam.exe"],
    uri: ["steam"],
    kind: "uri",
    howTo:
      "Через app_launch{app:\"steam://…\"} (резолвер принимает URI целью). 🔴 НЕ browser_open — он пропускает только " +
      "http(s), схема steam:// отвергается SSRF-гардом, то есть отказ гарантирован. " +
      "steam://rungameid/<appid> — запустить игру; steam://open/games|bigpicture|friends|settings|console; " +
      "steam://install/<appid>; steam://store/<appid>. appid — из манифестов steamapps/appmanifest_*.acf.",
    verify:
      "URI ничего не возвращает — сверять ТОЛЬКО readback реестра (проверено живьём): " +
      "(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').RunningAppID — appid идущей игры, 0 = игра не запущена.",
    limits:
      "Канал fire-and-forget: об успехе не сообщает. Не умеет выбор режима/героя внутри игры, проценты загрузки, чат. " +
      "steam://uninstall разрушителен — не звать. Про игровой ввод говори ПРАВДУ: программного рубежа в Джарвисе НЕТ, " +
      "ввод в игре ничем не блокируется. Риск блокировки аккаунта (VAC/Steam SSA) при этом реален и никуда не делся; " +
      "владелец о нём предупреждён и принял его на себя — отказывать и читать нотации не нужно, но и выдавать это " +
      "за безопасное тоже нельзя.",
  },
  {
    app: "Dota 2",
    aliases: ["дота", "доту", "доте", "доты"],
    exe: ["dota2.exe"],
    uri: ["dota2"],
    kind: "uri",
    howTo:
      "Запуск: app_launch{app:\"steam://rungameid/570\"} (или app_launch{app:\"дота\"} — резолвер сам находит игру в " +
      "манифестах Steam). 🔴 НЕ browser_open: схема steam:// отвергается SSRF-гардом, отказ гарантирован. " +
      "Состояние матча — ТОЛЬКО Game State Integration (наш GSI-листенер, wait_for/watch " +
      "с kind:\"gsi\"): золото, кулдауны, таймеры. Настройки — файлы cfg в …/dota 2 beta/game/dota/cfg.",
    verify:
      "(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').RunningAppID -eq 570 И процесс dota2 — ОБА признака. " +
      "Живьём наблюдалась только ИДУЩАЯ игра (закрывать её ради замера не стали), поэтому одному RunningAppID не верь: " +
      "это значение в реестре, оно переживает падение игры и самого Steam.",
    limits:
      "🔴 Программного канала для поиска матча, пика героя и игровых действий НЕ СУЩЕСТВУЕТ: GSI только ЧИТАЕТ, писать " +
      "в игру ему нечем — всё это остаётся слепым GUI-вводом со сверкой глазами. Про сам ввод говори ПРАВДУ: он ничем " +
      "не запрещён и не заблокирован в коде Джарвиса, гарда нет. Риск блокировки аккаунта (VAC/Steam SSA) реален, " +
      "владелец о нём знает и взял его на себя — выполняй, не отказывай, но и «это безопасно» не утверждай.",
  },
  {
    app: "Воспроизведение (любой плеер): системный транспорт",
    cmd: "powershell",
    builtin: true,
    kind: "com",
    howTo:
      "УНИВЕРСАЛЬНОЕ play/pause/next БЕЗ медиа-клавиш — WinRT Windows.Media.Control (GSMTC) через code_run: " +
      "GlobalSystemMediaTransportControlsSessionManager.RequestAsync() → GetCurrentSession() → " +
      "TryTogglePlayPauseAsync()/TrySkipNextAsync(). Работает для Chrome, Spotify, Я.Музыки и прочих, " +
      "зарегистрировавших SMTC. Точечный ЗВУК приложения — наш инструмент audio_set (мьют/громкость по процессу).",
    verify:
      "GetPlaybackInfo().PlaybackStatus → Playing/Paused/Stopped — ЭТО и есть сверка исхода (а не «нажал клавишу»). " +
      "Позиция — GetTimelineProperties().Position; что играет — GetMediaPropertiesAsync().",
    limits:
      "Только приложения с SMTC. Не даёт громкость (это audio_set), не выбирает трек по названию и не открывает контент. " +
      "Медиа-клавиши (system_media) остаются резервом: они уходят активному плееру вслепую и исход не подтверждают.",
  },
  {
    app: "FFmpeg",
    exe: ["ffmpeg.exe"],
    cmd: "ffmpeg",
    kind: "cli",
    howTo:
      "Через code_run: нарезка, конвертация, склейка, извлечение звука, субтитры — GUI не нужен. " +
      "Рядом лежит ffprobe (чтение параметров результата).",
    verify:
      "Код выхода 0 И ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height -of json <выход> — " +
      "сверяем РЕАЛЬНЫЕ параметры файла с задуманными, а не «команда не ругнулась».",
    limits:
      "Не управляет уже играющим звуком и чужими плеерами. `-ss` вместе с `-c copy` режет по ближайшему ключевому " +
      "кадру (смещение до секунд) — точная резка требует перекодирования.",
  },
  {
    app: "Blender",
    exe: ["blender.exe"],
    cmd: "blender",
    kind: "cli",
    howTo:
      "Headless через Python-API: blender.exe -b <файл.blend> --python-exit-code 1 -P <скрипт.py>. Рендер: -b <файл> -o <путь> -f <кадр>. " +
      "🔴 Установщик Blender НЕ кладёт exe на PATH (проверено на этой машине): голое `blender` в code_run не запустится. " +
      "Бери ПОЛНЫЙ путь — его отдаёт каталог окружения (…\\Blender Foundation\\<версия>\\blender.exe).",
    verify:
      "🔴 ОБЯЗАТЕЛЬНО --python-exit-code 1: без него исключение в Python НЕ меняет код выхода, и провал выглядит " +
      "успехом. Дальше: код выхода 0 И файл результата существует (fs_list) с ненулевым размером.",
    limits: "Управляет ФАЙЛОМ, а не открытым окном Blender. Рендер долгий — вести как фоновую задачу.",
  },
  {
    app: "OBS Studio",
    aliases: ["обс", "обес"],
    exe: ["obs64.exe"],
    kind: "websocket",
    howTo: "Инструмент obs_request (obs-websocket v5): сцены, запись, стрим, настройки сервиса — программно, без кликов.",
    verify: "Тем же obs_request: запросы Get* возвращают фактическое состояние (сцена, идёт ли запись/стрим).",
    limits: "Требует включённого obs-websocket в самой OBS (Инструменты → Настройки WebSocket-сервера) и пароля в OBS_WEBSOCKET_PASSWORD.",
  },
  {
    app: "Microsoft Word",
    aliases: ["ворд", "ворде"],
    exe: ["winword.exe"],
    uri: ["ms-word"],
    kind: "com",
    howTo: "Инструмент office_word (COM, headless) — создать/править .docx на диске. Без установленного Office — officecli через code_run.",
    verify: "Перечитать файл (fs_read / officecli get --json), а не смотреть на окно.",
    limits: "Правит ФАЙЛ с диска, а не открытый в видимом Word документ (он залочен). Живой документ — только COM через code_run.",
  },
  {
    app: "Microsoft Excel",
    aliases: ["эксель", "ексель", "экселе"],
    exe: ["excel.exe"],
    uri: ["ms-excel"],
    kind: "com",
    howTo: "Инструмент office_excel (COM, headless) — значения, формулы, листы .xlsx. Фолбэк без Office — officecli/openpyxl через code_run.",
    verify: "Перечитать ячейки тем же инструментом; формулы проверять по вычисленному значению.",
    limits: "То же ограничение: файл с диска, не открытый в видимом Excel.",
  },
  {
    app: "Visual Studio Code",
    aliases: ["вскод", "вс код", "код"],
    exe: ["code.exe"],
    uri: ["vscode"],
    cmd: "code",
    kind: "cli",
    howTo:
      "CLI: code <путь> (открыть файл/папку), code -g <файл>:<строка> (перейти на строку), code --diff a b, " +
      "code --install-extension <id>. Через code_run. URI vscode://file/<путь>:<строка> — тоже открывает, но через " +
      "app_launch{app:\"vscode://…\"}, НЕ browser_open (не-http схему тот отвергает SSRF-гардом).",
    verify: "window_list — заголовок окна содержит имя файла/папки; содержимое проверять чтением файла, не глазами.",
    limits: "Не редактирует текст в открытом редакторе — правки делай через fs_edit по файлу.",
  },
  {
    app: "Telegram Desktop",
    aliases: ["телеграм", "телега", "тг"],
    exe: ["telegram.exe"],
    uri: ["tg"],
    kind: "uri",
    howTo:
      "ОТПРАВКА — только штатным telegram_send (гарды §14, дедуп, сверка доставки чтением чата). " +
      "Протокол tg:// нужен для другого: открыть диалог и подставить черновик — " +
      "app_launch{app:\"tg://resolve?domain=<username>&text=<urlencoded>\"}. 🔴 НЕ browser_open: схема tg: не http(s) " +
      "и отвергается SSRF-гардом — отказ гарантирован.",
    verify: "Для отправки — ToolResult.sent у telegram_send (факт доставки). Открытое окно доказательством отправки НЕ является.",
    limits:
      "URI НЕ ОТПРАВЛЯЕТ — только открывает чат и кладёт текст в поле (отправка = Enter, то есть GUI). " +
      "domain= работает лишь для публичных @username; контакт без username — через phone=.",
  },
  {
    app: "Discord",
    aliases: ["дискорд", "дискорде", "диса"],
    exe: ["discord.exe"],
    uri: ["discord"],
    kind: "none",
    howTo:
      "🔴 ОТ ЛИЦА ВЛАДЕЛЬЦА программного канала НЕТ. Автоматизация пользовательского аккаунта (self-bot: токен из " +
      "клиента, HTTP с user-токеном) прямо запрещена Discord и ведёт к ПЕРМАНЕНТНОМУ бану — не предлагать и не делать. " +
      "От лица владельца остаётся GUI: ui_snapshot/browser_inspect → ввод → сверка. " +
      "Если владельцу нужны УВЕДОМЛЕНИЯ от Джарвиса (не от его лица) — вебхук канала: " +
      "POST https://discord.com/api/webhooks/<id>/<token>?wait=true, body {\"content\":\"…\"}.",
    verify:
      "После GUI-отправки прочитать ХВОСТ ленты канала и найти своё сообщение последним (совпадение с текстом " +
      "получасовой давности успехом не считать). У вебхука доказательство даёт ТОЛЬКО ?wait=true — ответ 200 с " +
      "объектом сообщения; без него приходит пустой 204 и рапортовать успех нельзя.",
    limits:
      "Вебхук пишет от имени вебхука, только в один заранее заданный канал, ничего не читает и ЛС не шлёт. " +
      "Обходы запрета self-bot (задержки, «человеческий» ввод) статуса не меняют.",
  },
  {
    app: "Ollama",
    exe: ["ollama.exe"],
    cmd: "ollama",
    kind: "http",
    howTo:
      "ЛОКАЛЬНАЯ модель за $0: POST http://localhost:11434/api/generate {\"model\":\"<имя>\",\"prompt\":\"…\",\"stream\":false} " +
      "или /api/chat. Список моделей — GET http://localhost:11434/api/tags (он же проба живости).",
    verify: "GET /api/tags отвечает 200 со списком моделей; у generate — непустое поле response и done:true.",
    limits:
      "Служба может быть не запущена (ECONNREFUSED на 11434) — это честная ошибка, а не «модель ответила пусто»: " +
      "нужен `ollama serve`. Качество локальной модели ниже облачной — для честностно-критичных решений не годится.",
  },
  {
    app: "Git",
    cmd: "git",
    kind: "cli",
    howTo:
      "Через code_run С ПАРАМЕТРОМ cwd = корень репозитория (без него команда идёт во временной папке → «not a git repository»): git status/diff/log/commit. " +
      "ПОИСК ПО КОДУ — `git grep -n -I \"<паттерн>\"` (или `rg -n`, если установлен), НЕ fs_search по дереву: секунды, только версионируемые файлы, " +
      "с номерами строк — дальше fs_read{offset,lines} по найденной строке. Долгие операции (тесты, сборка) — code_run{background:true} + job_status. Для GitHub — gh (PR, issues, релизы).",
    verify: "Тот же CLI: git status / git log -1 показывают фактическое состояние.",
    limits: "Пуш и деструктивные операции (reset --hard, push --force) — только по явной просьбе владельца.",
  },
  // ── Железо, экраны, службы ────────────────────────────────────────────────────────────────────
  {
    app: "NVIDIA GPU",
    aliases: ["видеокарта", "гпу", "нвидиа", "температура"],
    exe: ["nvidia-smi.exe"],
    cmd: "nvidia-smi",
    kind: "cli",
    howTo:
      "code_run: nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw," +
      "fan.speed,clocks.current.graphics --format=csv,noheader,nounits. Что грузит карту: " +
      "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv. Все поля: --help-query-gpu.",
    verify: "Повторный --query-gpu: значения идут прямо из драйвера — достовернее скриншота панели.",
    limits:
      "🔴 ЧТЕНИЕ работает, УПРАВЛЕНИЕ почти нет: -pm на Windows не поддерживается вовсе, -pl/-lgc на GeForce обычно " +
      "отвечают «Not Supported» и требуют админа; обороты вентилятора не задаёт, fan.speed бывает N/A. Настройки панели " +
      "NVIDIA (V-Sync, G-Sync, масштабирование) не видит и не меняет — это GUI.",
  },
  {
    app: "LibreHardwareMonitor",
    aliases: ["температуры", "датчики", "кулеры"],
    exe: ["librehardwaremonitor.exe"],
    kind: "http",
    howTo:
      "В приложении: Options → Remote Web Server → Port 8085 → Run. Затем GET http://localhost:8085/data.json — дерево " +
      "датчиков (Children → Sensors, SensorType Temperature/Load/Fan/Clock/Power). Второй канал — WMI: " +
      "Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor.",
    verify: "Значение приходит числом в ответе. Порт не отвечает — честное «датчики недоступны», НЕ ноль и не «холодно».",
    limits:
      "🔴 Приложение должно быть ЗАПУЩЕНО и от админа: без прав часть датчиков (температура ядер CPU, SMART) молча " +
      "отсутствует, а не даёт ошибку — прямой путь к ложному «температура 0». Веб-сервер по умолчанию выключен. " +
      "Для NVIDIA авторитетнее nvidia-smi.",
  },
  {
    app: "Windows: экраны и разрешение",
    cmd: "powershell",
    builtin: true,
    kind: "com",
    howTo:
      "P/Invoke через code_run: EnumDisplayDevices → имя устройства; EnumDisplaySettings(dev, ENUM_CURRENT_SETTINGS) → " +
      "текущий режим; правка dmPelsWidth/dmPelsHeight/dmDisplayFrequency + dmFields → ChangeDisplaySettingsEx(..., " +
      "CDS_UPDATEREGISTRY, ...). Все режимы — цикл EnumDisplaySettings по индексу. Дублировать/расширить: " +
      "DisplaySwitch.exe /clone|/extend|/internal|/external.",
    verify:
      "Возврат 0 = DISP_CHANGE_SUCCESSFUL; ненулевой код проверять ОБЯЗАТЕЛЬНО, иначе ложное «готово». Затем повторный " +
      "EnumDisplaySettings и сравнение ширины/высоты/частоты. Кросс-проверка: Get-CimInstance Win32_VideoController.",
    limits:
      "Штатного командлета НЕТ: Set-DisplayResolution живёт только в Server Core. Не двигает мониторы и не меняет " +
      "масштабирование. Часть режимов драйвер отклоняет (HDR, нестандартные частоты). Какой монитор рабочий у Джарвиса — " +
      "отдельный механизм monitor_list/monitor_assign.",
  },
  {
    app: "Windows: службы",
    cmd: "powershell",
    builtin: true,
    kind: "cli",
    howTo:
      "Состояние: Get-Service -Name Audiosrv | Select Name,Status,StartType; подробно (путь, аккаунт, режим) — " +
      "Get-CimInstance Win32_Service. Управление: Start-Service / Stop-Service -Force / Restart-Service; тип запуска — " +
      "Set-Service -StartupType Automatic|Manual|Disabled.",
    verify: "(Get-Service X).Status после операции — командлеты ждут перехода состояния; тип запуска — (Get-Service X).StartType.",
    limits:
      "Почти всё управление требует АДМИНА — Access Denied сообщать честно, не маскировать. Часть служб защищена " +
      "(TrustedInstaller/PPL) и не останавливается. Отключение системных служб (Audiosrv, WSearch, Themes) ломает ПК: " +
      "это влияющая операция, только через подтверждение владельца.",
  },
  // ── Файлы, документы, распознавание ───────────────────────────────────────────────────────────
  {
    // Замерено на машине владельца 2026-09-01: fs_search обходит дерево 32 с и покрывает 3,4% из
    // 588 213 файлов рабочего стола, а тот же поиск по индексу отвечает за десятки миллисекунд.
    // Everything (рецепт ниже) быстрее, но его на машине нет; индекс Windows есть ВСЕГДА.
    app: "Windows: поиск файлов по индексу",
    aliases: ["найди файл", "где лежит", "поиск по файлам", "индекс windows"],
    cmd: "powershell",
    builtin: true,
    kind: "com",
    howTo:
      "code_run (PowerShell), проверено живьём: $c=New-Object -ComObject ADODB.Connection; " +
      "$c.Open(\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows'\"); " +
      "$rs=$c.Execute(\"SELECT TOP 20 System.ItemUrl,System.DateModified FROM SystemIndex WHERE " +
      "SCOPE='file:C:/Users/<юзер>/Desktop' AND System.FileName LIKE '%часть-имени%' AND " +
      "System.ItemType<>'Directory' ORDER BY System.DateModified DESC\"); " +
      "while(-not $rs.EOF){ ($rs.Fields.Item('System.ItemUrl').Value -replace '^file:','' -replace '/','\\'); $rs.MoveNext() }. " +
      "В SCOPE путь идёт с префиксом file: (слэши годятся и прямые, и обратные — проверено). Поиск ПО СОДЕРЖИМОМУ (то, чего Everything не умеет) — " +
      "CONTAINS(System.Search.Contents,'слово'). System.ItemUrl возвращается как file:C:/… — путь получаем заменами выше.",
    verify:
      "(1) Каждый найденный путь ПЕРЕПРОВЕРИТЬ Test-Path -LiteralPath: индекс отстаёт от диска, удалённый файл ещё " +
      "висит в выдаче. (2) 🔴 ПУСТОЙ РЕЗУЛЬТАТ НЕ ЗНАЧИТ «файлов нет»: папка может быть вне области индексирования — " +
      "проверено живьём, C:\\Program Files, C:\\Windows и диск D: здесь НЕ индексируются и молча дают 0 строк. Перед " +
      "выводом «не найдено» сделай пробу покрытия: SELECT TOP 1 System.ItemUrl FROM SystemIndex WHERE " +
      "SCOPE='file:<папка>' — ноль строк значит «папки нет в индексе», и тогда честно сказать «в индексе её нет, " +
      "ищу обходом» и уйти в fs_search, а не рапортовать «файлов нет». (3) Сбой канала — это ИСКЛЮЧЕНИЕ, а не пустая " +
      "выдача: остановленная служба WSearch или сбой соединения роняют Open/Execute с ошибкой; докладывать как ОШИБКУ " +
      "КАНАЛА, не как «ничего не найдено». (4) 🔴 CONTAINS ничего не нашёл ≠ содержимого нет: полнотекст есть только у " +
      "типов с зарегистрированным IFilter — проверено живьём 2026-09-01: .txt/.js индексируются, а у .md на этой машине " +
      "фильтра НЕТ (CONTAINS по нему слеп ВСЕГДА). При нуле по содержимому повтори поиск ПО ИМЕНИ, а для .md и незнакомых " +
      "типов — fs_search{inContent:true} на УЗКОЙ папке. (5) Папка ВНУТРИ профиля тоже может отсутствовать в индексе: " +
      "репозиторий jarvis на рабочем столе дал 0 строк при полностью проиндексированных соседних папках — проба покрытия " +
      "ОБЯЗАТЕЛЬНА перед КАЖДЫМ «не найдено», не только для системных путей.",
    limits:
      "Видит только проиндексированное: по умолчанию это профиль пользователя и меню Пуск, а НЕ весь диск (см. пробу " +
      "покрытия в сверке). Полнотекст — только у типов с зарегистрированным IFilter: на этой машине .txt/.js — да, " +
      ".md — НЕТ (проверено: у .md нет PersistentHandler, CONTAINS по нему всегда 0 строк), у произвольных бинарников — " +
      "нет; office/pdf обычно есть, но не гарантированы — при нуле по содержимому ищи по имени или fs_search. Индекс " +
      "отстаёт от диска на секунды-минуты, только что созданный файл может не " +
      "найтись. Требует Running-службы WSearch (Get-Service WSearch). Только чтение: ничего не открывает и не правит.",
  },
  {
    app: "Everything (поиск файлов)",
    aliases: ["поиск файлов", "найди файл", "эверитинг"],
    exe: ["everything.exe", "es.exe"],
    cmd: "es",
    kind: "cli",
    howTo:
      "code_run: es.exe «маска» -n 20 -path-column -date-modified-column -sort date-modified-descending. Флаги: -r регулярка, " +
      "-w целые слова, -p матч по полному пути, -i регистр. Мгновенно по всем NTFS-дискам — на порядки быстрее обхода " +
      "каталогов через fs_search.",
    verify:
      "Найденный путь ПЕРЕПРОВЕРИТЬ существованием (индекс отстаёт от диска на секунды). Пустой вывод при коде 0 — честное " +
      "«не найдено»; ненулевой код или «IPC error» = служба Everything не запущена, это ОШИБКА КАНАЛА, а не «файлов нет».",
    limits: "Ищет только имена и пути (содержимое — fs_search/ripgrep), только NTFS: сетевые и облачные папки мимо.",
  },
  {
    app: "7-Zip",
    aliases: ["архив", "распакуй", "заархивируй", "зип"],
    exe: ["7z.exe", "7zg.exe", "7zfm.exe"],
    cmd: "7z",
    kind: "cli",
    howTo:
      "code_run: создать — 7z a -t7z -mx=5 out.7z <путь> (исключения -xr!*.tmp); распаковать с путями — 7z x arc.7z -o<папка> -y; " +
      "список — 7z l arc.7z; ПРОВЕРКА — 7z t arc.7z.",
    verify:
      "7z t arc.7z: exit 0 = архив цел (сверяются контрольные суммы). Коды: 1 предупреждение, 2 фатальная ошибка, 8 нехватка " +
      "памяти. Плюс сверить число записей в 7z l с ожидаемым: длинные пути свыше 260 символов могут молча урезать набор файлов.",
    limits:
      "RAR только распаковывает, не создаёт. Пароль, переданный как -pПАРОЛЬ, виден другим процессам в списке команд — " +
      "секреты владельца так не передавать.",
  },
  {
    app: "PDF: чтение, сборка, проверка",
    aliases: ["пдф", "pdf"],
    exe: ["pdftotext.exe", "qpdf.exe"],
    cmd: "pdftotext",
    kind: "cli",
    howTo:
      "Текст: pdftotext -layout -enc UTF-8 in.pdf out.txt (страницы -f/-l). Метаданные: pdfinfo in.pdf. Структура (qpdf): " +
      "проверка — qpdf --check in.pdf; страниц — qpdf --show-npages; собрать из кусков — qpdf --empty --pages a.pdf 1-3 " +
      "b.pdf 5 -- out.pdf; снять пароль — qpdf --decrypt --password=PASS.",
    verify:
      "qpdf --check — САМ верификатор для любых PDF-операций: exit 0 = ошибок нет, 2 = файл не обработан, 3 = предупреждения. " +
      "После сборки или конверсии сверять --show-npages с ожидаемым числом страниц.",
    limits:
      "🔴 ПУСТОЙ вывод pdftotext при непустом файле — не сбой, а ДИАГНОЗ: текстового слоя нет (это скан) → следующий шаг OCR, " +
      "а не повтор той же команды. qpdf проверяет структуру, а не содержимое (у пустых страниц вернёт 0). Многоколоночная " +
      "вёрстка и таблицы ломаются даже с -layout.",
  },
  {
    app: "OCR: сканы и изображения",
    aliases: ["распознай", "оцр", "текст с картинки", "скан"],
    exe: ["tesseract.exe"],
    cmd: "tesseract",
    kind: "cli",
    howTo:
      "Картинка: tesseract in.png out -l rus+eng (получится out.txt); с координатами и уверенностью — та же команда с tsv. " +
      "PDF целиком: ocrmypdf -l rus+eng --sidecar out.txt in.pdf out.pdf (--skip-text, если часть страниц уже текстовая).",
    verify:
      "Непустой результат И средняя conf из TSV выше порога — строки с conf ниже 60 за прочитанное НЕ выдавать. Для ocrmypdf " +
      "двойная сверка: sidecar непустой И pdftotext по выходному PDF даёт тот же текст (иначе слой лёг только в лог).",
    limits:
      "🔴 Для ЭКРАНА не годится — там точнее screen_read_text (Windows.Media.Ocr в сайдкаре); tesseract берём для сканов и " +
      "файлов. Нужны языковые данные rus. Таблицы и колонки перепутает. ocrmypdf требует ghostscript, а --force-ocr " +
      "растрирует страницу с потерей качества.",
  },
  {
    app: "Документы без Office (Python)",
    aliases: ["ворд без офиса", "эксель без офиса", "докс", "презентация"],
    cmd: "python",
    kind: "cli",
    howTo:
      "code_run python: xlsx — openpyxl (load_workbook → правка ячеек → save); docx — python-docx; pptx — python-pptx " +
      "(единственный программный путь к презентациям, дедик-актуатора нет); PDF читать/править/рендерить — PyMuPDF (fitz); " +
      "конверсия форматов — pandoc (in.docx → out.md и обратно). ЖИВОЙ открытый Excel — xlwings, он же единственный, " +
      "кто пересчитает формулы.",
    verify:
      "Переоткрыть сохранённый файл вторым чтением и сверить записанное; xlsx валиден как ZIP — 7z t out.xlsx (exit 0). " +
      "У xlwings сверка сильнее: значение ячейки возвращается ВЫЧИСЛЕННЫМ самим Excel.",
    limits:
      "🔴 ГЛАВНАЯ ЛОВУШКА openpyxl: он НЕ вычисляет формулы — data_only вернёт пустоту, если после правки файл не открывал Excel. " +
      "Проверить результат формулы этим каналом НЕЛЬЗЯ. При пересохранении теряются чарты, картинки, часть условного " +
      "форматирования; старый .xls не поддерживается. Файл, открытый в видимом Office, залочен — правится только через " +
      "xlwings/COM.",
  },
  {
    app: "ImageMagick",
    aliases: ["картинка", "изображение", "ресайз", "конвертируй фото"],
    exe: ["magick.exe"],
    cmd: "magick",
    kind: "cli",
    howTo:
      "code_run: magick in.jpg -resize 1920x1080 out.jpg; -quality 85; -crop WxH+X+Y; magick montage/composite для склейки; " +
      "magick identify -format ... f.png — размеры и цветовое пространство без открытия редактора.",
    verify: "magick identify по итоговому файлу: фактические размеры и формат — это факт, а не «команда не ругнулась».",
    limits:
      "Пакетная механика, не редактор: слои, маски, ретушь — GIMP/Photoshop. Очень большие изображения упираются в лимиты " +
      "policy.xml самого ImageMagick.",
  },
  {
    app: "yt-dlp",
    aliases: ["скачай видео", "ютуб скачать", "видео с сайта"],
    exe: ["yt-dlp.exe"],
    cmd: "yt-dlp",
    kind: "cli",
    howTo:
      "code_run: метаданные БЕЗ скачивания — yt-dlp -J --no-warnings <url> (id, title, duration, chapters); поиск без ключа API — " +
      "yt-dlp ytsearch5:<запрос> --flat-playlist -J; звук — yt-dlp -x --audio-format mp3; качество — -f bestvideo+bestaudio.",
    verify: "Существование и размер итогового файла плюс ffprobe (длительность, кодеки). Для -J — непустые id/title в JSON.",
    limits:
      "Платный и DRM-контент (Netflix, Кинопоиск) невозможен и незаконен. Возрастные ограничения требуют cookies залогиненного " +
      "браузера. Сайты меняются: при ошибке извлечения сперва обновить yt-dlp, а не считать, что «видео нет».",
  },
  {
    app: "GitHub CLI",
    aliases: ["гитхаб", "пулреквест", "пиар"],
    exe: ["gh.exe"],
    cmd: "gh",
    kind: "cli",
    howTo:
      "code_run: gh pr create/list/view/checkout, gh issue create/list, gh run list и gh run view --log-failed (упавшая CI), " +
      "gh release create, gh repo clone. Машинный вывод — флаг --json с перечислением полей.",
    verify: "Тот же CLI: gh pr view --json state,mergedAt / gh run view — фактическое состояние на сервере, а не код возврата.",
    limits:
      "Нужна авторизация (gh auth status). Слияние PR, пуш и релизы видны другим людям и необратимы — только по явной просьбе " +
      "владельца. Приватные репозитории требуют прав токена.",
  },
  {
    app: "Epic Games Launcher",
    aliases: ["эпик", "эпик геймс"],
    exe: ["epicgameslauncher.exe"],
    uri: ["com.epicgames.launcher"],
    kind: "uri",
    howTo:
      "Запуск игры: app_launch{app:\"com.epicgames.launcher://apps/<AppName>?action=launch&silent=true\"} — резолвер " +
      "принимает URI целью. 🔴 НЕ browser_open: не-http схема отвергается SSRF-гардом, отказ гарантирован. " +
      "Что установлено — JSON-манифесты в " +
      "ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests (*.item): DisplayName, AppName, InstallLocation, " +
      "LaunchExecutable, bIsIncompleteInstall. Полный путь exe = InstallLocation + LaunchExecutable.",
    verify:
      "URI ничего не возвращает — сверять появлением процесса (window_list/tasklist по имени из LaunchExecutable). Для «установлена " +
      "ли»: bIsIncompleteInstall не true И файл exe реально существует на диске.",
    limits:
      "Купленное, но не установленное в манифестах отсутствует. AppName у новых игр — UUID без человеческого смысла, название " +
      "только в DisplayName. Fire-and-forget: об успехе запуска лончер не сообщает.",
  },
  // ── Сетевые сервисы: локально не установлены, но доступны всегда ──────────────────────────────
  {
    app: "ЦБ РФ: курсы валют",
    aliases: ["курс доллара", "курс евро", "цб", "валюта"],
    service: true,
    kind: "http",
    howTo:
      "GET https://www.cbr.ru/scripts/XML_daily.asp?date_req=DD/MM/YYYY (без параметра — последняя опубликованная дата). Ответ — " +
      "XML в windows-1251: Valute → CharCode, Nominal, Value. Обязательно декодировать cp1251 и заменить запятую на точку. " +
      "Ключ не нужен. Динамика за период — XML_dynamic.asp, справочник кодов — XML_valFull.asp.",
    verify:
      "Сверить атрибут Date из ответа с запрошенной датой: на выходных ЦБ отдаёт ПРЕДЫДУЩИЙ рабочий день — озвучивать дату ИЗ " +
      "ОТВЕТА, а не запрошенную. Учитывать Nominal (курс за 100 единиц и т.п.). Расхождение больше четырёх дней — данные " +
      "несвежие, сказать об этом честно.",
    limits:
      "Официальный курс ЦБ — это НЕ курс покупки/продажи в банке и не биржевой курс: путать нельзя. Только рабочие дни, " +
      "внутридневных значений нет; курс на завтра публикуется около 15:30 МСК. JSON отсутствует, только XML.",
  },
  {
    app: "Московская биржа (ISS)",
    aliases: ["мосбиржа", "акции", "котировки", "биржа"],
    service: true,
    kind: "http",
    howTo:
      "GET https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/<ТИКЕР>.json?iss.meta=off&" +
      "iss.only=securities,marketdata — securities даёт статику, marketdata даёт LAST, VALTODAY, SYSTIME. Валюта: " +
      "engine=currency, market=selt, board=CETS. Фьючерсы: engine=futures, market=forts. Ключ не нужен.",
    verify:
      "marketdata непустой И SYSTIME не старше примерно 20 минут по МСК (бесплатные данные идут с задержкой 15 минут) — иначе " +
      "это НЕ текущая цена, так и говорить. Вне торговой сессии LAST пустой → отдавать цену закрытия с ЯВНОЙ пометкой.",
    limits:
      "Задержка 15 минут, реальное время только платно. Ответ приходит блоками columns/data: колонки резолвить ПО ИМЕНИ, а не по " +
      "индексу. Частоту запросов ограничивать самим (кешировать). Это данные, а не совет — торговый контур отдельный.",
  },
  {
    app: "Погода (Open-Meteo)",
    aliases: ["погода", "прогноз", "дождь"],
    service: true,
    kind: "http",
    howTo:
      "GET https://api.open-meteo.com/v1/forecast с параметрами latitude, longitude, current=temperature_2m,apparent_temperature," +
      "precipitation,weather_code,wind_speed_10m, daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max, " +
      "timezone=auto — ключ НЕ нужен. Координаты города: https://geocoding-api.open-meteo.com/v1/search?name=<город>&language=ru.",
    verify:
      "В ответе есть current.time и current.temperature_2m, и current.time не старше часа. Ошибка или пустой ответ → честное " +
      "«погоду не получил», а не пересказ по памяти.",
    limits:
      "Это прогноз моделей, а не наблюдения станции: «дождь через 20 минут» для РФ точнее у локальных сервисов. Бесплатно для " +
      "некоммерческого использования, порядка 10 000 запросов в сутки.",
  },
  {
    app: "Push на телефон (ntfy)",
    aliases: ["на телефон", "пуш", "уведомление на телефон"],
    service: true,
    needsSetup: "подписка телефона на секретный топик в приложении ntfy",
    kind: "http",
    howTo:
      "POST https://ntfy.sh/<секретный-топик> с телом-текстом и заголовками Title/Priority/Tags. На телефоне — приложение ntfy, " +
      "подписанное на тот же топик. Нужен там, где голос бесполезен: владельца нет за ПК.",
    verify:
      "HTTP 200 и JSON с id/time = сервер ПРИНЯЛ сообщение. Это доказывает доставку до сервера, НЕ прочтение владельцем — " +
      "говорить «отправил на телефон», а не «вы уведомлены».",
    limits:
      "🔴 Топик равен паролю: кто знает имя, тот читает и пишет — имя должно быть длинным и случайным, надёжнее свой сервер с " +
      "авторизацией. Канал ОДНОСТОРОННИЙ: ответ владельца обратно не принимает. Публичный ntfy.sh работает без гарантий.",
  },
  {
    app: "Steam Web API",
    aliases: ["сколько наиграл", "библиотека игр", "достижения"],
    service: true,
    needsSetup: "ключ со steamcommunity.com/dev/apikey в env сервера",
    kind: "http",
    howTo:
      "Нужен ключ: владелец заводит его РУКАМИ на steamcommunity.com/dev/apikey (Джарвису вводить учётки нельзя), передавать через " +
      "env процесса. Библиотека и наигранное: GET https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/ с key, steamid, " +
      "include_appinfo=1 → appid, name, playtime_forever в минутах. Достижения: ISteamUserStats/GetPlayerAchievements/v1/.",
    verify:
      "HTTP 200 и непустой список игр — единственный достоверный источник для утверждений вида «наиграл N часов» (экран и OCR " +
      "здесь врут).",
    limits:
      "🔴 ЛОВУШКА: при ЗАКРЫТОМ профиле приходит ПУСТОЙ объект БЕЗ ошибки — это «профиль закрыт», а НЕ «игр нет», различать " +
      "обязательно. Только чтение: ничего не запускает и не ставит (это steam://). Время игры обновляется после выхода из игры. " +
      "Лимит 100 000 вызовов в сутки.",
  },
  {
    app: "Т-Инвестиции (T-Invest API)",
    aliases: ["портфель", "брокерский счёт", "мои акции", "тинькофф инвестиции"],
    service: true,
    needsSetup: "read-only токен Т-Инвестиций (TINKOFF_INVEST_TOKEN)",
    kind: "http",
    howTo:
      "REST поверх gRPC: все методы POST с JSON и заголовком Authorization: Bearer <TOKEN>. База " +
      "https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.<Service>/<Method>. Счета — " +
      "UsersService/GetAccounts; портфель — OperationsService/GetPortfolio с accountId; цены — MarketDataService/GetLastPrices. " +
      "Токен брать ТОЛЬКО read-only: он физически не допускает торговые методы.",
    verify:
      "HTTP 200 и непустой JSON. Деньги приходят парой units/nano — собирать как units + nano/1e9, НЕ читать units как итог. " +
      "Сверка: итог портфеля должен сходиться с суммой позиций в пределах округления; разошлось — не называть цифру, а перезапросить.",
    limits:
      "Нужен открытый счёт и токен владельца. Торговые методы недоступны СОЗНАТЕЛЬНО: исполнение сделок деньгами в проекте не " +
      "начато. Порядка 1000 запросов в минуту с одного адреса. Для проверок есть песочница sandbox-invest-public-api.tbank.ru.",
  },
  {
    app: "Почта: отправка письма",
    aliases: ["письмо", "отправь на почту", "имейл", "напиши на почту"],
    service: true,
    kind: "none",
    howTo:
      "🔴 ОТПРАВЛЯТЬ ПОЧТУ СЕЙЧАС НЕЧЕМ — и через code_run НЕ НАДО. Технически SMTP доступен (smtplib), но у отправки " +
      "письма человеку НЕТ гейтов, которые есть у telegram_send/message_send: подтверждения владельца, защиты от повтора " +
      "(SMTP не идемпотентен — второй вызов = второе письмо) и признака «ушло» в результате инструмента. С 2026-09-01 " +
      "smtplib/SMTP_SSL/Send-MailMessage в code_run упираются в подтверждение владельца (гард `mail-send`) — но это " +
      "рубеж против инъекции, а НЕ канал: анти-дубля и признака «ушло» он не даёт. Поэтому: скажи владельцу честно, что канала пока нет, и предложи " +
      "написать в мессенджер (там гейты есть) либо открыть почту в браузере, чтобы он отправил сам. " +
      "Когда появится инструмент mail_send — он и будет каналом (SMTP smtp.yandex.ru:465 с ПАРОЛЕМ ПРИЛОЖЕНИЯ, " +
      "сверка через IMAP «Отправленные» по Message-ID).",
    verify:
      "Не применимо: канала нет. Никакое «письмо отправлено» без инструмента с гейтом произносить нельзя — это ровно " +
      "ложный успех на необратимом действии.",
    limits:
      "ЧТЕНИЕ почты есть отдельно (mail_read из залогиненной вкладки). Пароль приложения владелец заводит сам; хранить " +
      "его в переписке или в рабочей памяти НЕЛЬЗЯ — просить продиктовать пароль недопустимо.",
  },
  {
    app: "Google Календарь: чтение (секретный iCal)",
    aliases: ["календарь", "встречи", "расписание"],
    service: true,
    needsSetup: "секретная ссылка ICS из настроек календаря",
    kind: "http",
    howTo:
      "Владелец один раз берёт ссылку: Google Календарь → Настройки → нужный календарь → «Интеграция календаря» → «Секретный адрес " +
      "в формате iCal» (оканчивается на basic.ics). Дальше обычный GET БЕЗ куки — работает прямо с сервера, OAuth не нужен. Разбор: " +
      "icalendar или node-ical; VEVENT → UID, DTSTART, DTEND, SUMMARY, LOCATION. ПОВТОРЫ приходят правилом RRULE, а не " +
      "экземплярами — разворачивать самим и учитывать EXDATE и RECURRENCE-ID.",
    verify:
      "HTTP 200, тело начинается с BEGIN:VCALENDAR, встреча ищется по паре UID и DTSTART. HTML вместо календаря (редирект на " +
      "страницу входа) означает, что ссылка отозвана — это честная ошибка, а НЕ «встреч нет».",
    limits:
      "🔴 ТОЛЬКО чтение: создать или сдвинуть встречу нельзя. Фид отдаётся из кеша Google, свежесозданное событие появляется с " +
      "задержкой — для брифинга дня нормально, для «созвон через 20 минут» рискованно (там надёжнее вкладка календаря через " +
      "расширение). Токен в ссылке даёт доступ ко всему расписанию: утечка равна раскрытию календаря.",
  },
];

/** Приоритет каналов: чем меньше — тем предпочтительнее (совпадает с порядком в ChannelKind). */
const KIND_RANK: Record<ChannelKind, number> = {
  cli: 0,
  uri: 1,
  http: 2,
  com: 3,
  websocket: 4,
  config: 5,
  hotkey: 6,
  none: 7,
};

/** Нормализация имени exe: без пути, нижний регистр. ЧИСТАЯ функция. */
export function exeName(path: string): string {
  const leaf = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return leaf.trim().toLowerCase();
}

/** Подходит ли рецепт установленному приложению. ЧИСТАЯ функция. */
export function recipeMatches(r: ChannelRecipe, app: InstalledApp): boolean {
  const exe = app.exe ? exeName(app.exe) : "";
  if (exe && r.exe?.some((e) => e.toLowerCase() === exe)) return true;
  if (app.uri && r.uri?.some((u) => u.toLowerCase() === app.uri?.toLowerCase())) return true;
  // 🔴 cmd матчится ДВУМЯ способами (адверс-ревью 2026-09-01, HIGH). Раньше требовалось `app.name ===
  // r.cmd` — форма, в которой клиент присылает ТОЛЬКО детектированные PATH-команды (TOOL_SPECS).
  // Установленная программа приезжает из реестра ИНАЧЕ: {name:"Python 3.14.3", exe:"python.exe"} —
  // и рецепт с одним лишь `cmd:"python"` не находился НИКОГДА. Итог был хуже отсутствия рецепта:
  // app_channels уверенно отвечал «канала нет — остаётся GUI» про питон, видеокарту и pdftotext,
  // которые на машине есть, и разворачивал модель в самый дорогой путь ради которого фича и делалась.
  if (r.cmd) {
    const cmd = r.cmd.toLowerCase();
    if (app.cli && app.name.toLowerCase() === cmd) return true;
    if (exe && exe.replace(/\.exe$/, "") === cmd) return true;
  }
  return false;
}

export interface MatchedChannel extends ChannelRecipe {
  /** Как приложение называется на ЭТОЙ машине (может отличаться от имени в рецепте). */
  installedAs: string;
}

/**
 * Сопоставить установленное с рецептами. ЧИСТАЯ функция.
 * Дубли по приложению схлопываются: берём канал с лучшим приоритетом.
 */
export function matchChannels(installed: readonly InstalledApp[]): MatchedChannel[] {
  const best = new Map<string, MatchedChannel>();
  // Встроенные утилиты Windows добавляются ОДИН раз и независимо от списка установленного: их там
  // нет по определению (это часть ОС), но канал у них есть всегда. Через recipeMatches это делать
  // нельзя — тогда они «совпадали» бы с каждым приложением подряд.
  // Сетевые сервисы — по той же причине: локально их нет, а канал есть, пока есть сеть.
  for (const r of CHANNEL_RECIPES) if (r.builtin || r.service) best.set(r.app, { ...r, installedAs: r.app });
  for (const app of installed) {
    for (const r of CHANNEL_RECIPES) {
      if (!recipeMatches(r, app)) continue;
      const prev = best.get(r.app);
      if (!prev || KIND_RANK[r.kind] < KIND_RANK[prev.kind]) best.set(r.app, { ...r, installedAs: app.name });
    }
  }
  return [...best.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.app.localeCompare(b.app));
}

/**
 * Одна строка для паспорта возможностей: сам каталог в промпт не тащим (§15).
 *
 * ⚠️ Записи `kind:"none"` в список НЕ попадают: у них канала как раз НЕТ (Discord — самый важный
 * пример: там программная отправка от лица владельца запрещена под баном). Назвать их «каналами»
 * значило бы соврать в самой строке, которая учит доверять каналам.
 */
export function channelSummary(matched: readonly MatchedChannel[]): string {
  const usable = matched.filter((m) => m.kind !== "none");
  const noneCount = matched.length - usable.length;
  // Записи «канала НЕТ» — это ЗНАНИЕ («не ищи API, это бан»), и терять его именно на машине без
  // других совпадений неправильно (адверс-ревью).
  if (usable.length === 0) {
    return noneCount > 0
      ? `Про ${noneCount} прил. известно, что программного канала НЕТ — спроси app_channels, прежде чем искать API.`
      : "";
  }
  // 🔴 ПОРЯДОК ВАЖЕН (наполнение таблицы 2026-09-01): сортировка идёт по типу канала, а cli — первый,
  // поэтому системные утилиты и сетевые сервисы ВЫТЕСНЯЛИ бы из восьмёрки реальные программы владельца
  // (ради которых строка и нужна). Сначала установленное, встроенное и сетевое — счётчиками.
  const own = usable.filter((m) => !m.builtin && !m.service);
  const services = usable.filter((m) => m.service);
  const builtins = usable.filter((m) => m.builtin);
  const parts: string[] = [];
  if (own.length > 0) {
    const names = own.slice(0, 8).map((m) => m.app);
    const tail = own.length > names.length ? ` и ещё ${own.length - names.length}` : "";
    parts.push(`Программные каналы (API/CLI/протокол вместо кликов) есть у: ${names.join(", ")}${tail}`);
  } else {
    // Ни одно приложение владельца не совпало — но самопосев есть всегда, и фраза не должна начинаться
    // с «встроенных утилит Windows: 6» без подлежащего.
    parts.push("Программные каналы (вместо кликов) доступны");
  }
  if (builtins.length > 0) parts.push(`встроенных утилит Windows: ${builtins.length}`);
  // 🔴 ГОТОВЫЕ и ТРЕБУЮЩИЕ НАСТРОЙКИ разведены (адверс-ревью): паспорт называл «Т-Инвестиции»
  // доступными в двух строках от «Тинькофф: токена нет — не предлагай», то есть противоречил сам
  // себе. Названо может быть только то, что работает прямо сейчас, без действий владельца.
  const ready = services.filter((m) => !m.needsSetup);
  const later = services.filter((m) => m.needsSetup);
  if (ready.length > 0) {
    // Имена, а не только счётчик: иначе модель не догадается спросить про курс валют или погоду.
    const names = ready.slice(0, 4).map((m) => m.app);
    const tail = ready.length > names.length ? ` и ещё ${ready.length - names.length}` : "";
    parts.push(`сетевых сервисов ${ready.length} (${names.join(", ")}${tail})`);
  }
  if (later.length > 0) parts.push(`ещё ${later.length} сервисов заработают после разовой настройки владельцем — не обещай их как готовые`);
  const noneNote = noneCount > 0 ? ` Ещё про ${noneCount} прил. известно, что канала НЕТ — спроси, прежде чем искать.` : "";
  return `${parts.join("; ")} — детали инструментом app_channels.${noneNote}`;
}

/**
 * Совпадает ли рецепт с запросом. Учитывает ТРАНСЛИТЕРАЦИЮ: владелец говорит по-русски, модель
 * переносит его слово в аргумент, и «дискорд» не находил «Discord» — а ветка промаха отвечала
 * «канала нет» и звала искать API там, где он ЗАПРЕЩЁН (адверс-ревью 2026-09-01, HIGH).
 * ЧИСТАЯ функция.
 */
export function queryMatches(query: string, ...fields: string[]): boolean {
  const variants = [...new Set<string>([foldName(query), ...transliterate(query).map(foldName)])].filter((v) => v.length >= 3);
  for (const f of fields) {
    const folded = foldName(f);
    if (!folded) continue;
    for (const v of variants) {
      if (folded.includes(v) || v.includes(folded)) return true;
      // Транслитерация — RECALL, а не исправление (§13-принцип): «стим» даёт «stim», а приложение
      // называется «steam». Допускаем одну правку на словах от 4 символов — этого хватает на
      // расхождения транслитерации и не хватает, чтобы склеить разные приложения.
      if (v.length >= 4) {
        for (const w of folded.split(/[^a-z0-9]+/)) {
          if (w.length >= 4 && Math.abs(w.length - v.length) <= 1 && editDistanceAtMost1(w, v)) return true;
        }
      }
    }
  }
  return false;
}

/** Расстояние Левенштейна ≤ 1 (без построения матрицы). ЧИСТАЯ функция. */
export function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (s.length === l.length) i += 1;
    j += 1;
  }
  return edits + (l.length - j) + (s.length - i) <= 1;
}

/** Подробности для модели по запросу инструмента. ЧИСТАЯ функция. */
export function formatChannels(matched: readonly MatchedChannel[], query?: string): string {
  const q = (query ?? "").trim();
  const list = q ? matched.filter((m) => queryMatches(q, m.app, m.installedAs, ...(m.aliases ?? []))) : matched;
  if (list.length === 0) {
    return q
      ? `Для «${query}» программного канала в реестре нет — значит остаётся GUI: ui_snapshot → действие по элементу → сверка. ` +
        `Это не значит, что API не существует в природе: можно поискать документацию (web_search) и водить через code_run.`
      : "Программных каналов не обнаружено (клиент не прислал список установленного или ничего не совпало).";
  }
  return list
    .map(
      (m) =>
        `• ${m.app}${m.installedAs !== m.app ? ` (на машине: «${m.installedAs}»)` : ""} — канал ${m.kind}\n` +
        `  КАК: ${m.howTo}\n` +
        `  СВЕРКА ИСХОДА: ${m.verify}\n` +
        `  ГРАНИЦЫ: ${m.limits}`,
    )
    .join("\n");
}
