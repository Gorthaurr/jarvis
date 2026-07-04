// §6, §18 — Главный цикл нативного Windows-сайдкара.
// Процесс запускается Electron-клиентом как дочерний (extraResources, stdio).
// Читает JSON-строки из stdin, пишет JSON-ответы в stdout.
// В одном процессе живут UIAutomation-грундинг (UiaGrounder) и SendInput-ввод (InputSynthesizer),
// что устраняет IPC-гонку «нашли элемент → успели кликнуть» (§6).

using System.Text.Json;
using SidecarWin;

// Установить кодировку stdout/stdin в UTF-8 без BOM (Node.js stdio ожидает UTF-8).
Console.InputEncoding  = System.Text.Encoding.UTF8;
Console.OutputEncoding = System.Text.Encoding.UTF8;

// Логировать в stderr, чтобы не засорять stdout (JSON-line протокол).
static void Log(string msg)
    => Console.Error.WriteLine($"[sidecar-win] {DateTime.UtcNow:HH:mm:ss.fff} {msg}");

Log("Запуск. Ожидание запросов на stdin...");
Log(InputSynthesizer.ReportDpiAwareness()); // §18 health-check: реально ли применился PerMonitorV2

// Страховка от залипания зажатых клавиш (§6): отпустить всё при ЛЮБОМ завершении процесса
// (нормальный выход, Ctrl+C, kill родителя), иначе игровая клавиша останется зажатой в ОС.
AppDomain.CurrentDomain.ProcessExit += (_, _) => InputSynthesizer.ReleaseAllHeld();
Console.CancelKeyPress += (_, _) => InputSynthesizer.ReleaseAllHeld();

using UiaGrounder grounder = new();
JsonSerializerOptions jsonOpts = ArgsHelper.Options;

// stdout — единственный канал и для RPC-ответов, и для push демо-событий (с другого
// потока, §8). Любая запись в Console.Out идёт под этим локом, иначе строки слипнутся.
object stdoutLock = new();

// Рекордер обучения демонстрацией (§8) — создаётся лениво по demo.record start.
DemoRecorder? recorder = null;

// Арбитр ввода (§6, user-takeover) — создаётся лениво по raw-input.subscribe enable.
InputArbiter? arbiter = null;

// -----------------------------------------------------------------------
// Главный цикл: каждая строка stdin — один IpcRequest
// -----------------------------------------------------------------------
string? line;
while ((line = Console.ReadLine()) is not null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;

    IpcRequest? req = null;
    try
    {
        req = JsonSerializer.Deserialize<IpcRequest>(line, jsonOpts);
        if (req is null) throw new InvalidOperationException("Пустой запрос");
    }
    catch (Exception ex)
    {
        // Нет id — отвечаем с id=""
        WriteError("", $"Ошибка парсинга запроса: {ex.Message}");
        continue;
    }

    await HandleRequestAsync(req);
}

// Снимаем глобальные хуки и отпускаем зажатые клавиши перед выходом.
InputSynthesizer.ReleaseAllHeld(); // §6: не оставляем «зажатый WASD» при закрытии stdin
arbiter?.Stop();
if (recorder is { IsRecording: true }) recorder.Stop();

Log("stdin закрыт. Завершение.");
return 0;

// -----------------------------------------------------------------------
// Диспетчер операций
// -----------------------------------------------------------------------
async Task HandleRequestAsync(IpcRequest req)
{
    try
    {
        object? data = req.Op switch
        {
            // §6 — резолв контрола по роли/имени
            "ground" => HandleGround(req),

            // §бесшумный-ввод — резолв контрола по КООРДИНАТАМ (для клика без курсора по точке из screen_capture)
            "ground.at" => HandleGroundAtPoint(req),

            // §6 — вызов UIA-паттерна по дескриптору
            "invoke" => HandleInvoke(req),

            // §6, §18 — синтетический клик (координаты или контрол-fallback)
            "click"  => HandleClick(req),

            // §6 — набор текста
            "type"   => HandleType(req),

            // §6 — отправка комбинации клавиш
            "key"    => HandleKey(req),

            // §19 — выделенный текст через TextPattern
            "read.selection" => HandleReadSelection(req),

            // §19 — выжимка a11y видимой области
            "read.window" => HandleReadWindow(req),

            // §6 — арбитраж ввода / user-takeover
            "raw-input.subscribe" => HandleRawInputSubscribe(req),

            // §8 — обучение демонстрацией: запись/останов глобального UIA-хука
            "demo.record" => HandleDemoRecord(req),

            _ => throw new InvalidOperationException($"Неизвестная операция: {req.Op}"),
        };

        WriteOk(req.Id, data);
    }
    catch (Exception ex)
    {
        Log($"Ошибка при выполнении '{req.Op}' (id={req.Id}): {ex.Message}");
        WriteError(req.Id, ex.Message);
    }

    await Task.CompletedTask; // оставляем async для будущих I/O-операций
}

// -----------------------------------------------------------------------
// Обработчики операций
// -----------------------------------------------------------------------

// "ground" — резолв контрола (§6)
object? HandleGround(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<GroundArgs>(req.Args);
    GroundResult? result = grounder.Ground(args.Role, args.Name, args.Scope);
    if (result is null)
        throw new InvalidOperationException(
            $"Элемент не найден: role={args.Role}, name={args.Name ?? "<any>"}");
    return result;
}

// "ground.at" — резолв элемента по координатам (§бесшумный-ввод). Координаты ЛОГИЧЕСКИЕ (96dpi, как click) →
// физические для UIA FromPoint. null → под точкой нет UIA-элемента (canvas/игра) → клиент деградирует.
object? HandleGroundAtPoint(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<GroundAtPointArgs>(req.Args);
    (double physX, double physY) = InputSynthesizer.LogicalToPhysical(args.X, args.Y);
    GroundResult? result = grounder.GroundAtPoint(physX, physY);
    if (result is null)
        throw new InvalidOperationException($"Под точкой ({args.X},{args.Y}) нет UIA-элемента (canvas/игра?).");
    return result;
}

// "invoke" — UIA-паттерн (§6)
object? HandleInvoke(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<InvokeArgs>(req.Args);
    grounder.Invoke(args.Handle, args.Pattern, args.Value);
    return new { success = true };
}

// "click" — SendInput по координатам или через контрол-fallback (§6, §18)
object? HandleClick(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<ClickArgs>(req.Args);
    string button = args.Button ?? "left";

    bool restore = args.RestoreCursor == true; // §бесшумный-ввод: вернуть курсор после физ.клика
    if (args.X.HasValue && args.Y.HasValue)
    {
        // Прямые координаты от vision-движка — ЛОГИЧЕСКИЕ (96dpi), масштабируем через DPI (§18).
        InputSynthesizer.Click(args.X.Value, args.Y.Value, button, restore);
    }
    else if (args.Handle.HasValue)
    {
        // Fallback-клик по a11y-элементу (§6): точка клика из UIA — уже ФИЗИЧЕСКАЯ,
        // поэтому ClickPhysical (без повторного DPI-масштаба).
        (double cx, double cy) = grounder.GetClickPoint(args.Handle.Value);
        InputSynthesizer.ClickPhysical(cx, cy, button, restore);
    }
    else
    {
        throw new ArgumentException("Необходимо указать x+y или handle");
    }

    return new { success = true };
}

// "type" — набор текста (§6)
object? HandleType(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<TypeArgs>(req.Args);
    InputSynthesizer.TypeText(args.Text);
    return new { success = true, length = args.Text.Length };
}

// "key" — комбинация клавиш (§6). mode: press|down|up, scancode: VK vs скан-код (игры).
object? HandleKey(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<KeyArgs>(req.Args);
    string mode = string.IsNullOrWhiteSpace(args.Mode) ? "press" : args.Mode;
    bool scancode = args.Scancode ?? false;

    InputSynthesizer.SendKeyCombo(args.Combo, mode, scancode);
    return new { success = true, combo = args.Combo, mode };
}

// "read.selection" — выделенный текст через TextPattern (§19)
object? HandleReadSelection(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<ReadSelectionArgs>(req.Args);
    SelectionResult result = grounder.GetSelection(args.Handle);
    return result;
}

// "read.window" — текстовая выжимка a11y (§19)
object? HandleReadWindow(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<ReadWindowArgs>(req.Args);
    WindowReadResult result = grounder.ReadWindow(args.Pid, args.MaxChars ?? 8_000);
    return result;
}

// "demo.record" — старт/стоп записи демонстрации навыка (§8)
object? HandleDemoRecord(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<DemoRecordArgs>(req.Args);
    string op = (args.Op ?? "").ToLowerInvariant();

    if (op == "start")
    {
        recorder ??= new DemoRecorder(PushDemoEvent, Log);
        recorder.Start();
        return new { success = true, recording = true };
    }

    if (op == "stop")
    {
        if (recorder is null) return new DemoStopResult(Array.Empty<DemoEventDto>());
        IReadOnlyList<DemoEventDto> events = recorder.Stop();
        return new DemoStopResult(events);
    }

    throw new InvalidOperationException($"demo.record: неизвестный op '{args.Op}'");
}

// Push демо-события в stdout (без id — отдельный канал, читается клиентом как onPush).
void PushDemoEvent(DemoEventDto e)
{
    var push = new DemoEventPush("demo", e.Role, e.Name, e.Action, e.Ts);
    string json = JsonSerializer.Serialize(push, jsonOpts);
    lock (stdoutLock) { Console.WriteLine(json); }
}

// "raw-input.subscribe" — арбитраж ввода / user-takeover (§6)
object? HandleRawInputSubscribe(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<RawInputSubscribeArgs>(req.Args);

    if (args.Enable)
    {
        arbiter ??= new InputArbiter(PushUserInput, Log);
        arbiter.Start();
        return new { success = true, subscribed = true };
    }

    arbiter?.Stop();
    return new { success = true, subscribed = false };
}

// Push «пользователь взялся за ввод» в stdout (отдельный канал, читается клиентом как onPush).
void PushUserInput(string kind)
{
    var push = new UserInputPush("user-input", kind, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    string json = JsonSerializer.Serialize(push, jsonOpts);
    lock (stdoutLock) { Console.WriteLine(json); }
}

// -----------------------------------------------------------------------
// Запись ответов в stdout (JSON-line)
// -----------------------------------------------------------------------
void WriteOk(string id, object? data)
{
    string json = JsonSerializer.Serialize(new IpcOkResponse(id, true, data), jsonOpts);
    lock (stdoutLock) { Console.WriteLine(json); }
}

void WriteError(string id, string error)
{
    string json = JsonSerializer.Serialize(new IpcErrResponse(id, false, error), jsonOpts);
    lock (stdoutLock) { Console.WriteLine(json); }
}
