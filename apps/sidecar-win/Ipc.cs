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
    [property: JsonPropertyName("scope")]   string? Scope   // pid или "" = весь рабочий стол
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
    [property: JsonPropertyName("button")]  string? Button  // "left"|"right"|"middle", по умолчанию "left"
);

public sealed record TypeArgs(
    [property: JsonPropertyName("text")]    string Text
);

public sealed record KeyArgs(
    [property: JsonPropertyName("combo")]   string Combo    // напр. "ctrl+c", "win+r", "alt+F4"
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
