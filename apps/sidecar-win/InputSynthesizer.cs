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
    private const uint KEYEVENTF_KEYDOWN  = 0x0000;
    private const uint KEYEVENTF_KEYUP    = 0x0002;
    private const uint KEYEVENTF_UNICODE  = 0x0004;
    private const uint KEYEVENTF_SCANCODE = 0x0008;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

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

        // Сначала переместить курсор
        SendMouseMove(px, py);

        // Нажать и отпустить
        (uint downFlag, uint upFlag) = button.ToLowerInvariant() switch
        {
            "right"  => (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _        => (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
        };

        INPUT[] inputs =
        [
            BuildMouseInput(px, py, downFlag | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
            BuildMouseInput(px, py, upFlag   | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
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
    /// </summary>
    public static void SendKeyCombo(string combo)
    {
        string[] parts = combo.ToLowerInvariant().Split('+', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return;

        ushort[] vkModifiers = Array.ConvertAll(
            parts[..^1],
            p => (ushort)ModifierToVk(p));
        ushort vkMain = (ushort)MainKeyToVk(parts[^1]);

        var inputs = new List<INPUT>();

        // Нажать модификаторы
        foreach (ushort vk in vkModifiers)
            inputs.Add(BuildKeyInput(vk, 0, KEYEVENTF_KEYDOWN));

        // Основная клавиша
        inputs.Add(BuildKeyInput(vkMain, 0, KEYEVENTF_KEYDOWN));
        inputs.Add(BuildKeyInput(vkMain, 0, KEYEVENTF_KEYUP));

        // Отпустить модификаторы в обратном порядке
        for (int i = vkModifiers.Length - 1; i >= 0; i--)
            inputs.Add(BuildKeyInput(vkModifiers[i], 0, KEYEVENTF_KEYUP));

        SendInputs(inputs.ToArray());
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

        // Масштабируем логические координаты → физические
        double scaleX = dpiX / 96.0;
        double scaleY = dpiY / 96.0;
        int physX = (int)(logX * scaleX);
        int physY = (int)(logY * scaleY);

        // Перевести в нормализованные абсолютные координаты [0..65535] виртуального экрана
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        int absX = (physX - vx) * 65535 / (vw - 1);
        int absY = (physY - vy) * 65535 / (vh - 1);

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
