// §8 — Запись навыка демонстрацией.
//
// Пользователь нажимает «Сделать скилл», показывает задачу мышью/клавиатурой —
// сайдкар через SetWinEventHook ловит ГЛОБАЛЬНЫЕ UI-события (invoke/select) во всех
// приложениях, резолвит элемент под курсором через UIAutomation и пишет НЕ координаты,
// а роль+имя элемента (§6 — грундинг по a11y). Поток событий уходит наверх:
//   - живьём, push-строкой в stdout (для счётчика в UI);
//   - целиком, как батч, по demo.record stop (авторитетный список для buildSkillDraft).
//
// Хук OUTOFCONTEXT требует отдельного потока с насосом сообщений (GetMessage), потому
// рекордер живёт в собственном STA-потоке. Свой процесс пропускаем (SKIPOWNPROCESS).
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace SidecarWin;

/// <summary>Глобальный рекордер UI-действий пользователя для обучения демонстрацией (§8).</summary>
public sealed class DemoRecorder
{
    // ── WinEvent-константы ────────────────────────────────────────
    private const uint EVENT_OBJECT_INVOKED          = 0x8001;
    private const uint EVENT_OBJECT_SELECTION         = 0x8006;
    private const uint EVENT_OBJECT_SELECTIONWITHIN   = 0x8009;
    private const uint WINEVENT_OUTOFCONTEXT          = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS        = 0x0002;
    private const uint WM_QUIT                        = 0x0012;

    private delegate void WinEventDelegate(
        IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(
        uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
        WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd; public uint message; public IntPtr wParam;
        public IntPtr lParam; public uint time; public POINT pt;
    }

    [DllImport("user32.dll")]
    private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    // ── состояние ─────────────────────────────────────────────────
    private readonly object _lock = new();
    private readonly List<DemoEventDto> _events = new();
    private readonly Action<DemoEventDto> _onEvent;
    private readonly Action<string> _log;

    private Thread? _thread;
    private uint _threadId;
    private IntPtr _hook;
    private WinEventDelegate? _proc; // держим ссылку — иначе GC соберёт делегат под нативным хуком
    private volatile bool _hookOk;  // удалось ли реально прикрепить WinEvent-хук (§8, честность)

    private string _lastKey = "";
    private long _lastTs;

    public bool IsRecording => _thread is not null;

    public DemoRecorder(Action<DemoEventDto> onEvent, Action<string> log)
    {
        _onEvent = onEvent;
        _log = log;
    }

    /// <summary>
    /// Начать запись (idempotent). Поднимает хук в отдельном STA-потоке.
    /// H13 (§8, честность): бросает, если WinEvent-хук РЕАЛЬНО не прикрепился —
    /// вызывающий (HandleDemoRecord) отдаёт ok:false вместо ложного «запись начата».
    /// </summary>
    public void Start()
    {
        if (_thread is not null) return;
        lock (_lock) { _events.Clear(); _lastKey = ""; _lastTs = 0; }

        _hookOk = false;
        using var ready = new ManualResetEventSlim(false);
        var t = new Thread(() => RunLoop(ready)) { IsBackground = true, Name = "demo-recorder" };
        t.SetApartmentState(ApartmentState.STA);
        _thread = t;
        t.Start();
        ready.Wait(2000);
        if (!_hookOk)
        {
            // Хук не встал (SetWinEventHook → NULL) — поток уже вышел сам после ready.Set().
            // Сбрасываем состояние, чтобы повторный Start мог попробовать снова, и честно падаем.
            _thread = null;
            _log("demo.record: SetWinEventHook вернул NULL — запись НЕ начата");
            throw new InvalidOperationException("demo.record: не удалось прикрепить UIA-хук записи");
        }
        _log("demo.record: запись начата (UIA-хук поднят)");
    }

    /// <summary>Остановить запись и вернуть накопленный батч событий.</summary>
    public IReadOnlyList<DemoEventDto> Stop()
    {
        var t = _thread;
        if (t is null) return Array.Empty<DemoEventDto>();
        PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        t.Join(2000);
        _thread = null;
        lock (_lock)
        {
            _log($"demo.record: запись остановлена, событий={_events.Count}");
            return new List<DemoEventDto>(_events);
        }
    }

    // ── поток хука + насос сообщений ──────────────────────────────
    private void RunLoop(ManualResetEventSlim ready)
    {
        _threadId = GetCurrentThreadId();
        _proc = OnWinEvent;
        _hook = SetWinEventHook(
            EVENT_OBJECT_INVOKED, EVENT_OBJECT_SELECTIONWITHIN,
            IntPtr.Zero, _proc, 0, 0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        _hookOk = _hook != IntPtr.Zero; // сигналим успех прикрепления ДО ready.Set() (H13)
        ready.Set();

        if (_hook == IntPtr.Zero)
        {
            _log("demo.record: SetWinEventHook вернул NULL — запись не работает");
            return;
        }

        // Насос сообщений: OUTOFCONTEXT-колбэки доставляются через очередь этого потока.
        while (GetMessage(out MSG msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        UnhookWinEvent(_hook);
        _hook = IntPtr.Zero;
    }

    // ── колбэк события ────────────────────────────────────────────
    private void OnWinEvent(IntPtr hHook, uint type, IntPtr hwnd,
        int idObject, int idChild, uint thread, uint time)
    {
        string action;
        if (type == EVENT_OBJECT_INVOKED) action = "invoke";
        else if (type >= EVENT_OBJECT_SELECTION && type <= EVENT_OBJECT_SELECTIONWITHIN) action = "select";
        else return; // прочие события из диапазона (statechange/namechange/…) — мимо

        try
        {
            if (!GetCursorPos(out POINT p)) return;
            AutomationElement? el = AutomationElement.FromPoint(new System.Windows.Point(p.X, p.Y));
            if (el is null) return;

            string role = el.Current.ControlType.ProgrammaticName; // "ControlType.Button"
            int dot = role.LastIndexOf('.');
            if (dot >= 0) role = role[(dot + 1)..];
            role = role.ToLowerInvariant();

            string name = el.Current.Name ?? "";
            // Игнорируем «пустые» контейнеры без имени (pane/window/custom) — это шум.
            if (name.Length == 0 && (role is "pane" or "window" or "custom" or "group")) return;

            long ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string key = $"{role}|{name}|{action}";

            lock (_lock)
            {
                // Дебаунс: один и тот же элемент даёт несколько событий подряд.
                if (key == _lastKey && ts - _lastTs < 300) return;
                _lastKey = key;
                _lastTs = ts;

                var dto = new DemoEventDto(role, name.Length == 0 ? null : name, action, ts);
                _events.Add(dto);
                _onEvent(dto);
            }
        }
        catch
        {
            // Резолв элемента под курсором может упасть (элемент исчез, COM-таймаут) — пропускаем.
        }
    }
}
