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

using UiaGrounder grounder = new();
JsonSerializerOptions jsonOpts = ArgsHelper.Options;

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

    if (args.X.HasValue && args.Y.HasValue)
    {
        // Прямые координаты от vision-движка — масштабируем через DPI (§18)
        InputSynthesizer.Click(args.X.Value, args.Y.Value, button);
    }
    else if (args.Handle.HasValue)
    {
        // Fallback: получить центр элемента из GroundResult (§6)
        // Перегрундим по handle, чтобы получить актуальный bbox
        GroundResult? r = grounder.Ground("button", null, null);
        // TODO(M1): добавить метод GetBbox(handle) в UiaGrounder для точного fallback
        throw new InvalidOperationException(
            "Fallback-клик по handle не реализован — используй ground + coords (TODO M1)");
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

// "key" — комбинация клавиш (§6)
object? HandleKey(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<KeyArgs>(req.Args);
    InputSynthesizer.SendKeyCombo(args.Combo);
    return new { success = true, combo = args.Combo };
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

// "raw-input.subscribe" — арбитраж ввода / user-takeover (§6) — скелет
object? HandleRawInputSubscribe(IpcRequest req)
{
    var args = ArgsHelper.Deserialize<RawInputSubscribeArgs>(req.Args);

    // TODO(M2): Установить low-level keyboard/mouse hook (SetWindowsHookEx WH_KEYBOARD_LL / WH_MOUSE_LL).
    //   Хук фильтрует события по dwExtraInfo:
    //   - если dwExtraInfo == InputSynthesizer.SyntheticMarker → синтетика, пропускаем (§6)
    //   - иначе → физический ввод пользователя → user-takeover: уведомить Electron по stdout
    //     и временно заблокировать выдачу команд от агента.
    //   Хук требует message loop (Application.Run / PeekMessage) в отдельном потоке.
    Log($"raw-input.subscribe enable={args.Enable} — TODO(M2): low-level hook не установлен");

    return new
    {
        success = true,
        subscribed = false,
        note = "raw-input арбитраж не реализован (TODO M2)"
    };
}

// -----------------------------------------------------------------------
// Запись ответов в stdout (JSON-line)
// -----------------------------------------------------------------------
void WriteOk(string id, object? data)
{
    string json = JsonSerializer.Serialize(new IpcOkResponse(id, true, data), jsonOpts);
    Console.WriteLine(json);
}

void WriteError(string id, string error)
{
    string json = JsonSerializer.Serialize(new IpcErrResponse(id, false, error), jsonOpts);
    Console.WriteLine(json);
}
