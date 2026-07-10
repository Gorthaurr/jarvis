// §6, §18 — JSON-line IPC между Electron-клиентом и нативным сайдкаром.
// Клиент (Electron) запускает SidecarWin.exe как дочерний процесс и общается
// с ним через stdin/stdout (newline-delimited JSON).
// Формат запроса:  { "id": "<uuid>", "op": "<операция>", "args": { ... } }
// Формат ответа:   { "id": "<uuid>", "ok": true|false, "data": <любой тип> | "error": "<строка>" }

using System.Text.Json;
using System.Text.Json.Serialization;

namespace SidecarWin;

/// <summary>Запрос от Electron-клиента.</summary>
public sealed record IpcRequest(
    [property: JsonPropertyName("id")]  string Id,
    [property: JsonPropertyName("op")]  string Op,
    [property: JsonPropertyName("args")] JsonElement Args
);

/// <summary>Успешный ответ.</summary>
public sealed record IpcOkResponse(
    [property: JsonPropertyName("id")]   string Id,
    [property: JsonPropertyName("ok")]   bool Ok,
    [property: JsonPropertyName("data")] object? Data
);

/// <summary>Ответ с ошибкой.</summary>
public sealed record IpcErrResponse(
    [property: JsonPropertyName("id")]    string Id,
    [property: JsonPropertyName("ok")]    bool Ok,
    [property: JsonPropertyName("error")] string Error
);

/// <summary>Результат грундинга — числовой дескриптор + ограничивающий прямоугольник.</summary>
public sealed record GroundResult(
    [property: JsonPropertyName("handle")] int Handle,
    [property: JsonPropertyName("x")]      double X,
    [property: JsonPropertyName("y")]      double Y,
    [property: JsonPropertyName("w")]      double W,
    [property: JsonPropertyName("h")]      double H,
    [property: JsonPropertyName("name")]   string Name,
    [property: JsonPropertyName("role")]   string Role
);

/// <summary>Результат read.window — текстовая выжимка a11y видимой области.</summary>
public sealed record WindowReadResult(
    [property: JsonPropertyName("text")]     string Text,
    [property: JsonPropertyName("truncated")] bool Truncated
);

/// <summary>Результат read.selection — выделенный текст.</summary>
public sealed record SelectionResult(
    [property: JsonPropertyName("text")] string Text
);

/// <summary>Разобрать аргумент из JsonElement, бросить InvalidOperationException если отсутствует.</summary>
public static class ArgsHelper
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // handle гуляет как число (C# int) ↔ строка (TS Target.handle: string). Разрешаем читать число из
        // строки, иначе invoke/click по handle-строке падал десериализацией (латентный баг ui.invoke-по-handle).
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public static T Deserialize<T>(JsonElement el)
    {
        return JsonSerializer.Deserialize<T>(el.GetRawText(), JsonOpts)
               ?? throw new InvalidOperationException($"Не удалось десериализовать аргументы как {typeof(T).Name}");
    }

    public static JsonSerializerOptions Options => JsonOpts;
}

// Аргументы конкретных операций -------------------------------------------

public sealed record GroundArgs(
    [property: JsonPropertyName("role")]    string Role,
    [property: JsonPropertyName("name")]    string? Name,
    // §Волна2 (2.4): scope null/"" = АКТИВНОЕ ОКНО с фолбэком на весь стол; pid = окно процесса; "desktop" = весь стол.
    [property: JsonPropertyName("scope")]   string? Scope,
    // §Волна2 (2.4): "substring" — матч имени по вхождению (без регистра); дефолт — точное совпадение.
    [property: JsonPropertyName("nameMode")] string? NameMode,
    // §Волна2 (2.4): AutomationId — устойчивый идентификатор элемента (точнее имени, если известен).
    [property: JsonPropertyName("automationId")] string? AutomationId
);

// §Волна2 (2.4): снапшот интерактивных элементов окна (set-of-marks) — дешёвые «глаза» для нативных окон.
public sealed record SnapshotArgs(
    [property: JsonPropertyName("pid")]      int? Pid,      // null = активное (foreground) окно
    [property: JsonPropertyName("maxItems")] int? MaxItems
);

public sealed record SnapshotItem(
    [property: JsonPropertyName("handle")]       int Handle,
    [property: JsonPropertyName("role")]         string Role,
    [property: JsonPropertyName("name")]         string Name,
    [property: JsonPropertyName("automationId")] string? AutomationId,
    [property: JsonPropertyName("value")]        string? Value,
    [property: JsonPropertyName("x")]            double X,
    [property: JsonPropertyName("y")]            double Y,
    [property: JsonPropertyName("w")]            double W,
    [property: JsonPropertyName("h")]            double H
);

public sealed record SnapshotResult(
    [property: JsonPropertyName("window")]    string Window,
    [property: JsonPropertyName("pid")]       int Pid,
    [property: JsonPropertyName("items")]     IReadOnlyList<SnapshotItem> Items,
    [property: JsonPropertyName("truncated")] bool Truncated
);

// §Волна2 (2.4): окна верхнего уровня (window.list / window.focus).
public sealed record WindowInfo(
    [property: JsonPropertyName("hwnd")]       long Hwnd,
    [property: JsonPropertyName("pid")]        int Pid,
    [property: JsonPropertyName("process")]    string Process,
    [property: JsonPropertyName("title")]      string Title,
    [property: JsonPropertyName("foreground")] bool Foreground,
    [property: JsonPropertyName("minimized")]  bool Minimized
);

public sealed record WindowListResult(
    [property: JsonPropertyName("windows")] IReadOnlyList<WindowInfo> Windows
);

public sealed record WindowFocusArgs(
    [property: JsonPropertyName("hwnd")]  long? Hwnd,
    [property: JsonPropertyName("query")] string? Query    // подстрока заголовка или имя процесса
);

public sealed record WindowFocusResult(
    [property: JsonPropertyName("focused")] bool Focused,  // ЧЕСТНЫЙ readback GetForegroundWindow
    [property: JsonPropertyName("hwnd")]    long Hwnd,
    [property: JsonPropertyName("title")]   string Title
);

// §Волна2 (2.3): локальный OCR (Windows.Media.Ocr) — текст с canvas/игр без vision-раунда LLM.
public sealed record OcrArgs(
    [property: JsonPropertyName("imageB64")] string ImageB64, // PNG/JPEG base64 (клиент снимает экран сам)
    [property: JsonPropertyName("lang")]     string? Lang     // BCP-47, напр. "ru"/"en"; null = язык профиля
);

public sealed record OcrLineDto(
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("x")]    double X,   // bbox строки В КООРДИНАТАХ ИЗОБРАЖЕНИЯ
    [property: JsonPropertyName("y")]    double Y,
    [property: JsonPropertyName("w")]    double W,
    [property: JsonPropertyName("h")]    double H
);

public sealed record OcrReadResult(
    [property: JsonPropertyName("text")]  string Text,
    [property: JsonPropertyName("lines")] IReadOnlyList<OcrLineDto> Lines
);

// §бесшумный-ввод: грунд по КООРДИНАТАМ (логические 96dpi, как у click) → handle actionable-элемента.
public sealed record GroundAtPointArgs(
    [property: JsonPropertyName("x")] double X,
    [property: JsonPropertyName("y")] double Y
);

public sealed record InvokeArgs(
    [property: JsonPropertyName("handle")]  int Handle,
    [property: JsonPropertyName("pattern")] string Pattern, // invoke|setValue|select|toggle|expand|scroll
    [property: JsonPropertyName("value")]   string? Value
);

public sealed record ClickArgs(
    [property: JsonPropertyName("x")]       double? X,
    [property: JsonPropertyName("y")]       double? Y,
    [property: JsonPropertyName("handle")]  int? Handle,    // fallback: грунд уже есть
    [property: JsonPropertyName("button")]  string? Button, // "left"|"right"|"middle", по умолчанию "left"
    // §бесшумный-ввод: вернуть курсор на прежнее место после физ.клика (клиент ставит true при простое юзера).
    [property: JsonPropertyName("restoreCursor")] bool? RestoreCursor,
    // §Волна2 (2.4): число кликов (2 = дабл-клик; интервал внутри GetDoubleClickTime — ОС склеит).
    [property: JsonPropertyName("count")]   int? Count
);

// §Волна2 (2.4): полная мышь — move/down/up/wheel/drag (координаты ЛОГИЧЕСКИЕ 96dpi, как у click).
public sealed record MouseArgs(
    [property: JsonPropertyName("op")]      string Op,      // "move"|"down"|"up"|"wheel"|"drag"
    [property: JsonPropertyName("x")]       double? X,
    [property: JsonPropertyName("y")]       double? Y,
    [property: JsonPropertyName("toX")]     double? ToX,    // drag: конечная точка
    [property: JsonPropertyName("toY")]     double? ToY,
    [property: JsonPropertyName("button")]  string? Button, // "left"|"right"|"middle" (down/up/drag)
    [property: JsonPropertyName("dy")]      int? Dy,        // wheel: вертикальные тики (+вверх, −вниз)
    [property: JsonPropertyName("dx")]      int? Dx         // wheel: горизонтальные тики
);

public sealed record TypeArgs(
    [property: JsonPropertyName("text")]    string Text
);

public sealed record KeyArgs(
    [property: JsonPropertyName("combo")]    string Combo,   // напр. "ctrl+c", "win+r", "alt+F4"
    [property: JsonPropertyName("mode")]     string? Mode,   // "press" (по умолч.) | "down" (удержать) | "up" (отпустить)
    [property: JsonPropertyName("scancode")] bool? Scancode  // true → KEYEVENTF_SCANCODE (для игр DirectInput/RawInput)
);

public sealed record ReadWindowArgs(
    [property: JsonPropertyName("pid")]     int? Pid,
    [property: JsonPropertyName("maxChars")] int? MaxChars
);

public sealed record ReadSelectionArgs(
    [property: JsonPropertyName("handle")]  int? Handle
);

public sealed record RawInputSubscribeArgs(
    [property: JsonPropertyName("enable")]  bool Enable
);

/// <summary>Аргументы demo.record — старт/стоп записи демонстрации навыка (§8).</summary>
public sealed record DemoRecordArgs(
    [property: JsonPropertyName("op")]      string Op       // "start" | "stop"
);

/// <summary>UIA-событие записи демонстрации — роль/имя элемента + действие, НЕ координаты (§8).</summary>
public sealed record DemoEventDto(
    [property: JsonPropertyName("role")]    string Role,
    [property: JsonPropertyName("name")]    string? Name,
    [property: JsonPropertyName("action")]  string Action,
    [property: JsonPropertyName("ts")]      long Ts
);

/// <summary>Push-сообщение демо-события в stdout (без id — отдельный канал от RPC-ответов).</summary>
public sealed record DemoEventPush(
    [property: JsonPropertyName("event")]   string Event,   // всегда "demo"
    [property: JsonPropertyName("role")]    string Role,
    [property: JsonPropertyName("name")]    string? Name,
    [property: JsonPropertyName("action")]  string Action,
    [property: JsonPropertyName("ts")]      long Ts
);

/// <summary>Результат demo.record stop — батч пойманных событий.</summary>
public sealed record DemoStopResult(
    [property: JsonPropertyName("events")]  IReadOnlyList<DemoEventDto> Events
);

/// <summary>Push-сигнал «пользователь взялся за ввод» (user-takeover, §6) — отдельный канал.</summary>
public sealed record UserInputPush(
    [property: JsonPropertyName("event")]   string Event,   // всегда "user-input"
    [property: JsonPropertyName("kind")]    string Kind,    // "mouse" | "keyboard"
    [property: JsonPropertyName("ts")]      long Ts
);
