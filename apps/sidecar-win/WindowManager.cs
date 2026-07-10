// §Волна2 (2.4) — Окна верхнего уровня: перечисление и фокус БЕЗ PowerShell.
//
// window.list — дешёвые «глаза» на уровне окон: {hwnd, pid, process, title, foreground,
// minimized} за миллисекунды (замена 12с-таймера снапшота и спавна PowerShell).
// window.focus — SetForegroundWindow с AttachThreadInput-трюком и ЧЕСТНЫМ readback
// (GetForegroundWindow после попытки): вернул focused=false — фокус реально не взят,
// вызывающий откатывается на AppActivate (apps.ts) или докладывает провал (§честность).

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace SidecarWin;

public static class WindowManager
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int pvAttribute, int cbAttribute);

    private const int SW_RESTORE = 9;
    /// <summary>UWP-призраки: окно «видимо», но заклоакано DWM (фоновые Store-приложения) — в списке не нужно.</summary>
    private const int DWMWA_CLOAKED = 14;

    /// <summary>Активное (foreground) окно — для дефолтного scope грундинга/снапшота (§Волна2).</summary>
    public static IntPtr Foreground() => GetForegroundWindow();

    /// <summary>Перечислить видимые титулованные окна верхнего уровня (без DWM-клоак).</summary>
    public static WindowListResult List()
    {
        var windows = new List<WindowInfo>();
        IntPtr fg = GetForegroundWindow();
        // Кэш имён процессов на один вызов: у одного pid много окон, Process.GetProcessById недёшев.
        var procNames = new Dictionary<uint, string>();

        EnumWindows((h, _) =>
        {
            try
            {
                if (!IsWindowVisible(h)) return true;
                if (IsCloaked(h)) return true;
                int len = GetWindowTextLength(h);
                if (len <= 0) return true;
                var sb = new StringBuilder(len + 1);
                GetWindowText(h, sb, sb.Capacity);
                string title = sb.ToString().Trim();
                if (title.Length == 0) return true;

                GetWindowThreadProcessId(h, out uint pid);
                if (!procNames.TryGetValue(pid, out string? proc))
                {
                    try { proc = Process.GetProcessById((int)pid).ProcessName; }
                    catch { proc = ""; }
                    procNames[pid] = proc ?? "";
                }

                windows.Add(new WindowInfo(
                    Hwnd: h.ToInt64(),
                    Pid: (int)pid,
                    Process: procNames[pid],
                    Title: title,
                    Foreground: h == fg,
                    Minimized: IsIconic(h)));
            }
            catch { /* одно проблемное окно не рушит список */ }
            return true;
        }, IntPtr.Zero);

        return new WindowListResult(windows);
    }

    private static bool IsCloaked(IntPtr h)
    {
        try
        {
            return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Сфокусировать окно: по hwnd (точно) или по подстроке заголовка/имени процесса (без регистра).
    /// Свернутое — восстанавливаем (SW_RESTORE). Foreground-lock Windows обходим AttachThreadInput
    /// (наш поток «приклеивается» к потоку текущего foreground-окна) + ALT-нудж при упорстве.
    /// Возвращает ЧЕСТНЫЙ readback: focused=false — фокус реально не перешёл.
    /// </summary>
    public static WindowFocusResult Focus(long? hwnd, string? query)
    {
        IntPtr target = hwnd.HasValue ? new IntPtr(hwnd.Value) : FindByQuery(query);
        if (target == IntPtr.Zero)
            throw new InvalidOperationException($"Окно не найдено: {(hwnd.HasValue ? $"hwnd={hwnd}" : $"query=«{query}»")}");

        if (IsIconic(target)) ShowWindow(target, SW_RESTORE);

        TrySetForeground(target);
        System.Threading.Thread.Sleep(60);
        bool focused = GetForegroundWindow() == target;
        if (!focused)
        {
            // ALT-нудж: удержание Alt снимает foreground-lock (классический обход ограничения
            // SetForegroundWindow). Ревью Волны 2: ДЕРЖИМ Alt ВОКРУГ SetForegroundWindow (down →
            // set → up), а не полный press ДО него — голое нажатие-отпускание Alt в чужом окне
            // взводит menu-mode/KeyTips (Office/Explorer), и следующий ввод уходил бы в меню.
            InputSynthesizer.HoldCombo("alt", scancode: false);
            try
            {
                TrySetForeground(target);
                System.Threading.Thread.Sleep(80);
            }
            finally
            {
                InputSynthesizer.ReleaseCombo("alt", scancode: false);
            }
            focused = GetForegroundWindow() == target;
        }

        string title = TitleOf(target);
        return new WindowFocusResult(focused, target.ToInt64(), title);
    }

    private static void TrySetForeground(IntPtr target)
    {
        uint curThread = GetCurrentThreadId();
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out _);
        bool attached = fgThread != 0 && fgThread != curThread && AttachThreadInput(curThread, fgThread, true);
        try
        {
            SetForegroundWindow(target);
        }
        finally
        {
            if (attached) AttachThreadInput(curThread, fgThread, false);
        }
    }

    private static string TitleOf(IntPtr h)
    {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString().Trim();
    }

    /// <summary>Найти окно по подстроке заголовка ИЛИ имени процесса (case-insensitive). Foreground-окна не предлагаем (уже в фокусе — no-op не нужен, но вернём его же честно).</summary>
    private static IntPtr FindByQuery(string? query)
    {
        string q = (query ?? "").Trim();
        if (q.Length == 0) return IntPtr.Zero;
        WindowListResult all = List();
        // Приоритет: точное имя процесса → подстрока заголовка → подстрока имени процесса.
        WindowInfo? byProcExact = all.Windows.FirstOrDefault(w => string.Equals(w.Process, q, StringComparison.OrdinalIgnoreCase));
        WindowInfo? byTitle = all.Windows.FirstOrDefault(w => w.Title.Contains(q, StringComparison.OrdinalIgnoreCase));
        WindowInfo? byProc = all.Windows.FirstOrDefault(w => w.Process.Contains(q, StringComparison.OrdinalIgnoreCase));
        WindowInfo? hit = byProcExact ?? byTitle ?? byProc;
        return hit is null ? IntPtr.Zero : new IntPtr(hit.Hwnd);
    }
}
