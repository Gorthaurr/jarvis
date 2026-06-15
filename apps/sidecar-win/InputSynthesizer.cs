// §6, §18 — Синтетический ввод через Win32 SendInput с Per-Monitor DPI Awareness V2.
// Координаты от vision-движка передаются в логических пикселях рабочего стола (96 dpi).
// Перед отправкой они масштабируются под физические пиксели монитора с учётом DPI (§18).
//
// dwExtraInfo-маркер: все синтетические события помечаются константой SyntheticMarker,
// чтобы low-level хук raw-input-арбитража мог отличить их от физического ввода (§6).

using System.Runtime.InteropServices;
using System.Text;

namespace SidecarWin;

/// <summary>
/// Синтез мыши и клавиатуры через Win32 SendInput.
/// Поддерживает Per-Monitor DPI Awareness V2 (§6, §18).
/// </summary>
public static class InputSynthesizer
{
    // -----------------------------------------------------------------------
    // Маркер синтетики (§6) — произвольная уникальная константа
    // -----------------------------------------------------------------------
    public const nuint SyntheticMarker = 0x4A415256; // "JARV" в ASCII

    // -----------------------------------------------------------------------
    // Реестр УДЕРЖАНИЙ (§6, безопасность игр): зажатые клавиши, которые НЕ были отпущены.
    // Без него keydown(mode=down) без парного keyup оставляет клавишу зажатой в ОС даже
    // после смерти процесса («персонаж бежит вечно»). Watchdog авто-отпускает по таймауту,
    // ReleaseAllHeld() вызывается при выходе/закрытии stdin.
    // -----------------------------------------------------------------------
    private static readonly object _heldLock = new();
    private static readonly Dictionary<ushort, bool> _held = new(); // vk → отправлен ли сканкодом
    private static long _heldDeadlineMs;
    private static System.Threading.Timer? _watchdog;
    /// <summary>Авто-release удержаний, не продлённых дольше этого срока (страховка от залипания).</summary>
    private const long HoldTtlMs = 15_000;

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // -----------------------------------------------------------------------
    // P/Invoke — структуры и функции Win32
    // -----------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int     dx;
        public int     dy;
        public uint    mouseData;
        public uint    dwFlags;
        public uint    time;
        public nuint   dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort  wVk;
        public ushort  wScan;
        public uint    dwFlags;
        public uint    time;
        public nuint   dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT_UNION
    {
        [FieldOffset(0)] public MOUSEINPUT   mi;
        [FieldOffset(0)] public KEYBDINPUT   ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint        type;
        public INPUT_UNION u;
    }

    // INPUT.type
    private const uint INPUT_MOUSE    = 0;
    private const uint INPUT_KEYBOARD = 1;

    // dwFlags для мыши
    private const uint MOUSEEVENTF_MOVE        = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN    = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP      = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN   = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP     = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN  = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP    = 0x0040;
    private const uint MOUSEEVENTF_ABSOLUTE    = 0x8000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    // dwFlags для клавиатуры
    private const uint KEYEVENTF_KEYDOWN     = 0x0000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP       = 0x0002;
    private const uint KEYEVENTF_UNICODE     = 0x0004;
    private const uint KEYEVENTF_SCANCODE    = 0x0008;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    // MapVirtualKey — VK → scancode (для KEYEVENTF_SCANCODE, чтобы игры на
    // DirectInput/RawInput видели ввод как «настоящий» физический скан-код).
    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    private const uint MAPVK_VK_TO_VSC = 0; // VK → scancode

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    // SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79, SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77
    private const int SM_XVIRTUALSCREEN  = 76;
    private const int SM_YVIRTUALSCREEN  = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hmonitor, uint dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x, y; }

    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const uint MDT_EFFECTIVE_DPI = 0;

    // -----------------------------------------------------------------------
    // Публичный API
    // -----------------------------------------------------------------------

    /// <summary>
    /// Нажать левую (или правую/среднюю) кнопку мыши по логическим координатам (96 dpi).
    /// §18 — маппинг vision-координат на физические пиксели с учётом DPI монитора.
    /// </summary>
    public static void Click(double logicalX, double logicalY, string button = "left")
    {
        (int px, int py) = LogicalToAbsolute(logicalX, logicalY);
        ClickAbsolute(px, py, button);
    }

    /// <summary>
    /// Клик по ФИЗИЧЕСКИМ экранным координатам (§6, fallback-клик по элементу).
    /// UIA BoundingRectangle/GetClickablePoint в Per-Monitor-V2 процессе уже в физических
    /// пикселях — DPI-масштабирование тут НЕ применяем (иначе двойной масштаб).
    /// </summary>
    public static void ClickPhysical(double physX, double physY, string button = "left")
    {
        (int ax, int ay) = PhysicalToAbsolute(physX, physY);
        ClickAbsolute(ax, ay, button);
    }

    private static void ClickAbsolute(int absX, int absY, string button)
    {
        // Сначала переместить курсор
        SendMouseMove(absX, absY);

        (uint downFlag, uint upFlag) = button.ToLowerInvariant() switch
        {
            "right"  => (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _        => (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
        };

        INPUT[] inputs =
        [
            BuildMouseInput(absX, absY, downFlag | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
            BuildMouseInput(absX, absY, upFlag   | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
        ];

        SendInputs(inputs);
    }

    /// <summary>
    /// Набрать текст посимвольно через Unicode SendInput.
    /// Для каждого символа — пара keydown/keyup с KEYEVENTF_UNICODE.
    /// </summary>
    public static void TypeText(string text)
    {
        if (string.IsNullOrEmpty(text)) return;

        var inputs = new List<INPUT>(text.Length * 2);
        foreach (char c in text)
        {
            inputs.Add(BuildKeyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYDOWN));
            inputs.Add(BuildKeyInput(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }

        SendInputs(inputs.ToArray());
    }

    /// <summary>
    /// Нажать комбинацию клавиш, например "ctrl+c", "win+r", "alt+F4".
    /// Поддерживает модификаторы: ctrl, shift, alt, win.
    /// Обратная совместимость: keydown+keyup через VK (mode=press, scancode=false).
    /// </summary>
    public static void SendKeyCombo(string combo) => PressCombo(combo, scancode: false);

    /// <summary>
    /// Диспетчер режима ввода комбинации (§6 — управление в играх).
    /// mode: "press" (нажать+отпустить, по умолчанию), "down" (нажать и удерживать),
    /// "up" (отпустить). scancode=true — слать через KEYEVENTF_SCANCODE (для DirectInput/RawInput).
    /// </summary>
    public static void SendKeyCombo(string combo, string? mode, bool scancode)
    {
        switch ((mode ?? "press").ToLowerInvariant())
        {
            case "down": HoldCombo(combo, scancode); break;
            case "up":   ReleaseCombo(combo, scancode); break;
            case "press":
            case "":     PressCombo(combo, scancode); break;
            default:
                throw new ArgumentException($"Неизвестный mode: {mode} (ожидалось press|down|up)");
        }
    }

    /// <summary>
    /// Нажать и отпустить комбинацию (keydown+keyup). Текущее поведение, но с учётом scancode.
    /// </summary>
    public static void PressCombo(string combo, bool scancode)
    {
        (ushort[] vkModifiers, ushort vkMain) = ParseCombo(combo);

        var inputs = new List<INPUT>();

        // Нажать модификаторы
        foreach (ushort vk in vkModifiers)
            inputs.Add(BuildKey(vk, down: true, scancode));

        // Основная клавиша: down + up
        inputs.Add(BuildKey(vkMain, down: true, scancode));
        inputs.Add(BuildKey(vkMain, down: false, scancode));

        // Отпустить модификаторы в обратном порядке
        for (int i = vkModifiers.Length - 1; i >= 0; i--)
            inputs.Add(BuildKey(vkModifiers[i], down: false, scancode));

        SendInputs(inputs.ToArray());
    }

    /// <summary>
    /// Нажать и УДЕРЖАТЬ комбинацию (только keydown, без keyup) — для движения в игре.
    /// Модификаторы давятся первыми, затем основная клавиша.
    /// </summary>
    public static void HoldCombo(string combo, bool scancode)
    {
        (ushort[] vkModifiers, ushort vkMain) = ParseCombo(combo);

        var inputs = new List<INPUT>(vkModifiers.Length + 1);
        foreach (ushort vk in vkModifiers)
            inputs.Add(BuildKey(vk, down: true, scancode));
        inputs.Add(BuildKey(vkMain, down: true, scancode));

        SendInputs(inputs.ToArray());

        // Регистрируем удержание и продлеваем дедлайн (повторный down = keepalive).
        lock (_heldLock)
        {
            foreach (ushort vk in vkModifiers) _held[vk] = scancode;
            _held[vkMain] = scancode;
            _heldDeadlineMs = NowMs() + HoldTtlMs;
        }
        EnsureWatchdog();
    }

    /// <summary>
    /// Отпустить комбинацию (только keyup) — снять удержание.
    /// Основная клавиша отпускается первой, модификаторы — в обратном порядке.
    /// </summary>
    public static void ReleaseCombo(string combo, bool scancode)
    {
        (ushort[] vkModifiers, ushort vkMain) = ParseCombo(combo);

        var inputs = new List<INPUT>(vkModifiers.Length + 1);
        inputs.Add(BuildKey(vkMain, down: false, scancode));
        for (int i = vkModifiers.Length - 1; i >= 0; i--)
            inputs.Add(BuildKey(vkModifiers[i], down: false, scancode));

        SendInputs(inputs.ToArray());

        lock (_heldLock)
        {
            _held.Remove(vkMain);
            foreach (ushort vk in vkModifiers) _held.Remove(vk);
        }
    }

    /// <summary>
    /// Отпустить ВСЕ удерживаемые клавиши (страховка от залипания, §6).
    /// Вызывается watchdog'ом по таймауту и при выходе процесса / закрытии stdin.
    /// </summary>
    public static void ReleaseAllHeld()
    {
        INPUT[] inputs;
        lock (_heldLock)
        {
            if (_held.Count == 0) return;
            inputs = _held.Select(kv => BuildKey(kv.Key, down: false, kv.Value)).ToArray();
            _held.Clear();
        }
        try { SendInputs(inputs); } catch { /* best-effort: отпускаем что можем */ }
    }

    /// <summary>Поднять watchdog один раз: каждую секунду авто-отпускает протухшие удержания.</summary>
    private static void EnsureWatchdog()
    {
        if (_watchdog is not null) return;
        lock (_heldLock)
        {
            _watchdog ??= new System.Threading.Timer(_ => WatchdogTick(), null, 1000, 1000);
        }
    }

    private static void WatchdogTick()
    {
        bool expired;
        lock (_heldLock) { expired = _held.Count > 0 && NowMs() > _heldDeadlineMs; }
        if (expired) ReleaseAllHeld();
    }

    /// <summary>
    /// Разобрать "ctrl+shift+a" → (модификаторы VK, основная VK).
    /// Бросает ArgumentException на пустом combo / неизвестной клавише.
    /// </summary>
    private static (ushort[] modifiers, ushort main) ParseCombo(string combo)
    {
        string[] parts = (combo ?? "").ToLowerInvariant()
            .Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
            throw new ArgumentException("Пустая комбинация клавиш");

        ushort[] vkModifiers = Array.ConvertAll(parts[..^1], p => (ushort)ModifierToVk(p));
        ushort vkMain = (ushort)MainKeyToVk(parts[^1]);
        return (vkModifiers, vkMain);
    }

    // -----------------------------------------------------------------------
    // DPI-маппинг (§6, §18)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Перевести логические координаты (96 dpi, origin = левый верхний угол primary монитора)
    /// в абсолютные пиксельные координаты виртуального экрана.
    /// §18: масштабирование 125% = 120 dpi, 150% = 144 dpi, 200% = 192 dpi.
    /// </summary>
    private static (int px, int py) LogicalToAbsolute(double logX, double logY)
    {
        // Определить монитор в точке логических координат
        var pt = new POINT { x = (int)logX, y = (int)logY };
        IntPtr hMon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);

        uint dpiX = 96, dpiY = 96;
        // Игнорируем HResult — при ошибке остаёмся на 96 dpi
        _ = GetDpiForMonitor(hMon, MDT_EFFECTIVE_DPI, out dpiX, out dpiY);

        // Масштабируем логические координаты → физические, далее общий путь нормализации.
        double physX = logX * (dpiX / 96.0);
        double physY = logY * (dpiY / 96.0);
        return PhysicalToAbsolute(physX, physY);
    }

    /// <summary>
    /// Перевести ФИЗИЧЕСКИЕ пиксельные координаты в нормализованные абсолютные [0..65535]
    /// виртуального экрана (для SendInput MOUSEEVENTF_ABSOLUTE|VIRTUALDESK).
    /// </summary>
    private static (int ax, int ay) PhysicalToAbsolute(double physX, double physY)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        // Защита от деления на ноль на вырожденном/одно­пиксельном экране.
        int denomX = Math.Max(1, vw - 1);
        int denomY = Math.Max(1, vh - 1);

        // Зажимаем в пределах виртуального экрана, затем нормализуем.
        double clampedX = Math.Clamp(physX, vx, vx + vw - 1);
        double clampedY = Math.Clamp(physY, vy, vy + vh - 1);

        int absX = (int)Math.Round((clampedX - vx) * 65535.0 / denomX);
        int absY = (int)Math.Round((clampedY - vy) * 65535.0 / denomY);
        return (absX, absY);
    }

    // -----------------------------------------------------------------------
    // Вспомогательные методы построения INPUT
    // -----------------------------------------------------------------------

    private static void SendMouseMove(int absX, int absY)
    {
        INPUT[] mv = [BuildMouseInput(absX, absY, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)];
        SendInputs(mv);
    }

    private static INPUT BuildMouseInput(int absX, int absY, uint flags)
    {
        return new INPUT
        {
            type = INPUT_MOUSE,
            u = new INPUT_UNION
            {
                mi = new MOUSEINPUT
                {
                    dx = absX,
                    dy = absY,
                    mouseData = 0,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = SyntheticMarker, // §6 — маркер синтетики
                }
            }
        };
    }

    private static INPUT BuildKeyInput(ushort vk, ushort scan, uint flags)
    {
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUT_UNION
            {
                ki = new KEYBDINPUT
                {
                    wVk = vk,
                    wScan = scan,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = SyntheticMarker, // §6 — маркер синтетики
                }
            }
        };
    }

    /// <summary>
    /// Построить событие клавиши по VK с учётом режима (down/up) и способа доставки (VK vs scancode).
    /// При scancode=true wVk обнуляется, wScan = MapVirtualKey(vk, 0), ставится KEYEVENTF_SCANCODE.
    /// Расширенные клавиши (стрелки, Ins/Del/Home/End/PgUp/PgDn, RWin/Apps, NumpadEnter) получают
    /// KEYEVENTF_EXTENDEDKEY — без него игры воспринимают, напр., стрелки как Numpad-клавиши.
    /// </summary>
    private static INPUT BuildKey(ushort vk, bool down, bool scancode)
    {
        uint flags = down ? KEYEVENTF_KEYDOWN : KEYEVENTF_KEYUP;

        if (IsExtendedKey(vk))
            flags |= KEYEVENTF_EXTENDEDKEY;

        if (scancode)
        {
            // VK → scancode. Для расширенных клавиш MapVirtualKey даёт «короткий» байт
            // (напр. 0x4D у Right), а 0xE0-префикс системе сообщает KEYEVENTF_EXTENDEDKEY.
            ushort scan = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC);
            if (scan == 0)
                throw new ArgumentException($"Нет scancode для VK=0x{vk:X2}");
            return BuildKeyInput(0, scan, flags | KEYEVENTF_SCANCODE);
        }

        return BuildKeyInput(vk, 0, flags);
    }

    /// <summary>
    /// Расширенные виртуальные клавиши, требующие KEYEVENTF_EXTENDEDKEY (0xE0-префикс).
    /// Стрелки, навигационный блок, правый Ctrl/Alt, RWin, Apps, NumLock-зависимые,
    /// Divide и NumpadEnter (VK_RETURN с extended). Это критично для движения в играх (§6).
    /// </summary>
    private static bool IsExtendedKey(ushort vk) => vk switch
    {
        0x25 or 0x26 or 0x27 or 0x28 => true, // стрелки Left/Up/Right/Down
        0x21 or 0x22                 => true, // PageUp/PageDown
        0x23 or 0x24                 => true, // End/Home
        0x2D or 0x2E                 => true, // Insert/Delete
        0xA3                         => true, // RControl
        0xA5                         => true, // RMenu (RAlt)
        0x5B or 0x5C                 => true, // LWin/RWin
        0x5D                         => true, // Apps (контекстное меню)
        0x90                         => true, // NumLock
        0x6F                         => true, // Divide (Numpad /)
        0x2C                         => true, // PrintScreen / Snapshot
        _                            => false,
    };

    private static void SendInputs(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent != (uint)inputs.Length)
        {
            int err = Marshal.GetLastWin32Error();
            throw new InvalidOperationException($"SendInput отправил {sent}/{inputs.Length} событий, Win32Error={err}");
        }
    }

    // -----------------------------------------------------------------------
    // Маппинг имён клавиш → Virtual-Key коды
    // -----------------------------------------------------------------------

    private static int ModifierToVk(string mod) => mod switch
    {
        "ctrl"  => 0x11, // VK_CONTROL
        "shift" => 0x10, // VK_SHIFT
        "alt"   => 0x12, // VK_MENU
        "win"   => 0x5B, // VK_LWIN
        _       => throw new ArgumentException($"Неизвестный модификатор: {mod}"),
    };

    private static int MainKeyToVk(string key) => key switch
    {
        // Буквы A–Z
        var k when k.Length == 1 && k[0] >= 'a' && k[0] <= 'z' => k[0] - 'a' + 0x41,
        // Цифры 0–9
        var k when k.Length == 1 && k[0] >= '0' && k[0] <= '9' => k[0],
        // F-клавиши
        "f1"  => 0x70, "f2"  => 0x71, "f3"  => 0x72, "f4"  => 0x73,
        "f5"  => 0x74, "f6"  => 0x75, "f7"  => 0x76, "f8"  => 0x77,
        "f9"  => 0x78, "f10" => 0x79, "f11" => 0x7A, "f12" => 0x7B,
        // Спецклавиши
        "enter"     => 0x0D, "return" => 0x0D,
        "escape"    => 0x1B, "esc"    => 0x1B,
        "tab"       => 0x09,
        "space"     => 0x20,
        "backspace" => 0x08,
        "delete"    => 0x2E,
        "insert"    => 0x2D,
        "home"      => 0x24,
        "end"       => 0x23,
        "pageup"    => 0x21, "pgup" => 0x21,
        "pagedown"  => 0x22, "pgdn" => 0x22,
        "left"      => 0x25,
        "up"        => 0x26,
        "right"     => 0x27,
        "down"      => 0x28,
        "printscreen" => 0x2C,
        "capslock"  => 0x14,
        "numlock"   => 0x90,
        "scrolllock"=> 0x91,
        "pause"     => 0x13,
        "apps"      => 0x5D, // контекстное меню
        // Символы (не все — только часто используемые)
        ";"  => 0xBA, "="  => 0xBB, ","  => 0xBC, "-"  => 0xBD,
        "."  => 0xBE, "/"  => 0xBF, "`"  => 0xC0, "["  => 0xDB,
        "\\" => 0xDC, "]"  => 0xDD, "'"  => 0xDE,
        _ => throw new ArgumentException($"Неизвестная клавиша: {key}"),
    };
}
