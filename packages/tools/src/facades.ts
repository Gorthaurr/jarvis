/**
 * W4 «Руки» (2026-09-10, ревью §7.3 «сократить горячий набор, GUI-инструменты объединить»): ФАСАДЫ.
 *
 * Модель видит три горячих имени вместо пятнадцати: `look{what}` (глаза без картинки), `window{op}` (окна),
 * `audio{op}` (звук по приложениям). Каждый вызов фасада КАНОНИЗИРУЕТСЯ в прежний инструмент с прежним
 * входом — исполнение, классификация (verify/mutate/neutral), аренда ввода, метка чипа и авто-макрос работают
 * по каноническому имени, ничего из проводки не переписывается.
 *
 * Чистый модуль без импортов: им пользуются сервер (петля, dispatch, журнал, свёртка) и тесты.
 * 🔴 Канонизация НЕ мутирует вход: у канала подписки хендлер SDK сопоставляется с результатом по (имя,
 * канонический JSON аргументов) ТОГО объекта ToolUse, что положил SDK, — изменить его in-place значило бы
 * подвесить хендлер на 10 минут (subscription-session.ts). Возвращаем новый объект, `tu` не трогаем.
 */

export interface CanonicalCall {
  name: string;
  input: Record<string, unknown>;
}

/** Имена фасадов (горячие) — единственное место, где они перечислены. */
export const FACADE_TOOL_NAMES: ReadonlySet<string> = new Set(["look", "window", "audio"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const pick = (i: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (i[k] !== undefined) out[k] = i[k];
  return out;
};

/**
 * Фасад → канонический инструмент. Незнакомое имя или не-фасад → как есть (новый объект). Неизвестный `what`/`op`
 * фасада → имя фасада как есть: dispatch ответит честной ошибкой «неизвестный инструмент», а не выберет что-то наугад.
 */
export function canonicalToolCall(name: string, input: unknown): CanonicalCall {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "look": {
      switch (str(i.what)) {
        case "elements":
          return { name: "ui_snapshot", input: pick(i, ["pid", "maxItems"]) };
        case "text":
          return { name: "screen_read_text", input: pick(i, ["monitor", "rect", "lang"]) };
        case "windows":
          return { name: "window_list", input: {} };
        case "context":
          return { name: "context_read", input: { scope: str(i.scope) ?? "active_window" } };
        default:
          return { name, input: { ...i } };
      }
    }
    case "window": {
      switch (str(i.op)) {
        case "focus":
          return { name: "window_focus", input: pick(i, ["hwnd", "query"]) };
        case "list":
          return { name: "window_list", input: {} };
        case "minimize":
        case "maximize":
        case "restore":
        case "move":
          return { name: "window_arrange", input: { ...pick(i, ["hwnd", "query", "monitor", "maximizeAfterMove"]), op: str(i.op) } };
        default:
          return { name, input: { ...i } };
      }
    }
    case "audio": {
      switch (str(i.op)) {
        case "list":
          return { name: "audio_sessions", input: {} };
        case "set":
          return { name: "audio_set", input: pick(i, ["pid", "process", "mute", "level"]) };
        default:
          return { name, input: { ...i } };
      }
    }
    default:
      return { name, input: { ...i } };
  }
}

/** Каноническое имя без входа не вычислить у фасада — оно зависит от what/op; хелпер для потребителей convo. */
export function canonicalToolName(name: string, input: unknown): string {
  return canonicalToolCall(name, input).name;
}
