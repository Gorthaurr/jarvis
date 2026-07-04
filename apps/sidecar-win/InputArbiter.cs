// §6 — Арбитраж ввода / user-takeover.
//
// Низкоуровневые хуки WH_MOUSE_LL / WH_KEYBOARD_LL ловят ВЕСЬ ввод в системе.
// Свою синтетику (InputSynthesizer) отличаем по dwExtraInfo == SyntheticMarker и
// пропускаем. Любой ФИЗИЧЕСКИЙ ввод пользователя → push-событие "user-input" в stdout,
// чтобы клиент мог мгновенно уступить управление (поставить агента на паузу), пока
// человек работает руками. Это делает «отпустить руки» безопасным: перехватил — агент молчит.
//
// LL-хуки требуют насос сообщений в потоке-установщике (как и WinEvent в DemoRecorder).
using System.Runtime.InteropServices;

namespace SidecarWin;

/// <summary>Глобальный детектор физического ввода пользователя (user-takeover, §6).</summary>
public sealed class InputArbiter
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int HC_ACTION = 0;
    private const uint WM_QUIT = 0x0012;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public nuint dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public nuint dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    [DllImport("user32.dll")]
    private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    private readonly Action<string> _onUserInput; // kind: "mouse" | "keyboard"
    private readonly Action<string> _log;

    private Thread? _thread;
    private uint _threadId;
    private IntPtr _hMouse, _hKbd;
    private HookProc? _mouseProc, _kbdProc; // держим ссылки от GC
    private long _lastPushTs;
    private volatile bool _hooksOk; // удалось ли поднять хотя бы один хук

    public bool IsActive => _thread is not null;

    public InputArbiter(Action<string> onUserInput, Action<string> log)
    {
        _onUserInput = onUserInput;
        _log = log;
    }

    public void Start()
    {
        if (_thread is not null) return;
        using var ready = new ManualResetEventSlim(false);
        var t = new Thread(() => RunLoop(ready)) { IsBackground = true, Name = "input-arbiter" };
        t.SetApartmentState(ApartmentState.STA);
        _thread = t;
        t.Start();
        bool signalled = ready.Wait(2000);
        if (!signalled)
        {
            // M15: поток НЕ уложился в 2с ready-wait. Он мог просто затормозить на старте —
            // и всё равно поднимет LL-хуки и войдёт в GetMessage-петлю, оставшись жить.
            // Просто обнулить ссылку нельзя: осиротевший поток продолжит слать user-input,
            // а повторный Start заспавнит ВТОРОЙ. Гарантированно сносим спавненный поток до
            // возврата: дожидаемся, пока RunLoop проставит _threadId, шлём WM_QUIT и Join'им.
            // (WM_QUIT в очередь до её создания теряется — потому ждём _threadId и хендл хука.)
            ReapOrphan(t);
            _thread = null;
            _log("raw-input.subscribe: LL-хуки не встали за отведённое время — арбитраж не активен, поток снят");
            return;
        }
        if (!_hooksOk)
        {
            // Хуки не встали — сбрасываем состояние, чтобы арбитр не «завис активным»
            // и повторный Start мог попробовать снова.
            _thread = null;
            _log("raw-input.subscribe: не удалось поднять LL-хуки — арбитраж не активен");
            return;
        }
        _log("raw-input.subscribe: арбитраж ввода активирован (LL-хуки подняты)");
    }

    public void Stop()
    {
        var t = _thread;
        if (t is null) return;
        PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        t.Join(2000);
        _thread = null;
    }

    // M15: снять поток, «просроченный» на ready-wait, но, возможно, ещё поднимающийся.
    // Дожидаемся, пока RunLoop проставит _threadId (иначе WM_QUIT уйдёт в пустоту — очередь
    // сообщений потока ещё не создана), затем шлём WM_QUIT и Join'им. Если поток уже завершился
    // сам (хуки не встали → RunLoop вышел) — Join вернётся сразу.
    private void ReapOrphan(Thread t)
    {
        // Ждём появления threadId (или смерти потока) — коротко, поток уже почти поднялся.
        for (int i = 0; i < 100 && _threadId == 0 && t.IsAlive; i++)
            Thread.Sleep(20);

        if (_threadId != 0)
            PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);

        // Дожидаемся выхода RunLoop (снятия хуков). Если WM_QUIT не дошёл (очередь ещё не
        // готова была), повторяем на всякий случай.
        if (!t.Join(2000) && _threadId != 0)
        {
            PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            t.Join(2000);
        }
    }

    private void RunLoop(ManualResetEventSlim ready)
    {
        _threadId = GetCurrentThreadId();
        IntPtr hMod = GetModuleHandle(null);
        _mouseProc = MouseHook;
        _kbdProc = KbdHook;
        _hMouse = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, hMod, 0);
        _hKbd = SetWindowsHookEx(WH_KEYBOARD_LL, _kbdProc, hMod, 0);
        _hooksOk = _hMouse != IntPtr.Zero || _hKbd != IntPtr.Zero;
        ready.Set();

        if (!_hooksOk)
        {
            _log("raw-input.subscribe: SetWindowsHookEx вернул NULL — арбитраж не работает");
            return;
        }

        while (GetMessage(out MSG msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        if (_hMouse != IntPtr.Zero) UnhookWindowsHookEx(_hMouse);
        if (_hKbd != IntPtr.Zero) UnhookWindowsHookEx(_hKbd);
        _hMouse = _hKbd = IntPtr.Zero;
    }

    private IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == HC_ACTION)
        {
            var s = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            if (s.dwExtraInfo != InputSynthesizer.SyntheticMarker) Notify("mouse");
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private IntPtr KbdHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == HC_ACTION)
        {
            var s = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            if (s.dwExtraInfo != InputSynthesizer.SyntheticMarker) Notify("keyboard");
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private void Notify(string kind)
    {
        // Дебаунс: поток ввода плотный, шлём не чаще раза в 250 мс (дёшево, на потоке хука).
        long ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (ts - _lastPushTs < 250) return;
        _lastPushTs = ts;
        // ВАЖНО: запись в stdout (под локом) может заблокироваться при полном пайпе.
        // Внутри LL-хука это превысит LowLevelHooksTimeout (~300мс) → Windows СНИМЕТ хук.
        // Поэтому уносим push с потока хука в пул.
        ThreadPool.QueueUserWorkItem(_ => { try { _onUserInput(kind); } catch { /* push не должен ронять хук */ } });
    }
}
