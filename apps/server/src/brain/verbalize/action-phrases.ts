/**
 * Презентационный слой реплик tier0 (§11): озвучка успеха/провала локальных действий (запуск/фокус/
 * браузер/медиа/громкость). Вынесено из ядра agent-loop (god-object) — чистые функции, без состояния.
 * Формулировки РОТИРУЮТСЯ (не звучать роботом); все варианты называют объект, чтобы было ясно ЧТО сделано.
 */
import type { LocalIntent } from "../router/index.js";

/** Случайный вариант из пула — микро-вариативность реплик (§11). */
export function pick(variants: readonly string[]): string {
  return variants[Math.floor(Math.random() * variants.length)] ?? variants[0]!;
}

/** Капитализация первой буквы (для вариантов, начинающихся с имени приложения). */
export function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Подтверждение успеха tier0 (§11): называет объект (что сделано); «сэр» не в каждом — иначе приедается. */
export function successPhrase(intent: LocalIntent): string {
  switch (intent.kind) {
    case "app.launch":
      return pick([
        `Открыл ${intent.app}.`,
        `Готово, ${intent.app} запущен.`,
        `${cap(intent.app)} на экране.`,
        `Запустил ${intent.app}, сэр.`,
        `${cap(intent.app)} открыт.`,
      ]);
    case "app.focus":
      return pick([
        `Переключился на ${intent.app}.`,
        `${cap(intent.app)} перед вами.`,
        `Готово, вы в ${intent.app}.`,
        `Перешёл в ${intent.app}, сэр.`,
      ]);
    case "browser.open":
      return pick(["Открыл страницу.", "Готово, страница открыта.", "Открыл, сэр.", "Страница открыта."]);
    case "media":
      switch (intent.op) {
        case "pause":
          return pick(["Пауза.", "Поставил на паузу.", "Остановил."]);
        case "play":
          return pick(["Продолжаю.", "Воспроизвожу.", "Поехали."]);
        case "next":
          return pick(["Следующий.", "Переключил.", "Дальше."]);
        case "prev":
          return pick(["Предыдущий.", "Вернул назад.", "Откатил."]);
        case "stop":
          return "Остановил.";
        default:
          return "Готово.";
      }
    case "volume":
      switch (intent.op) {
        case "up":
          return pick(["Громче.", "Прибавил."]);
        case "down":
          return pick(["Тише.", "Убавил."]);
        case "mute":
          return pick(["Без звука.", "Заглушил."]);
        case "set":
          return `Громкость ${intent.level ?? ""}.`.replace(" .", ".");
        default:
          return "Готово.";
      }
    case "clarify":
      return intent.question; // недостижимо (clarify не доходит до runLocalIntent), но полнота типа
  }
}

/** Честный провал tier0 (§): называет объект и причину — не «готово», когда не вышло. */
export function failurePhrase(intent: LocalIntent, code?: string): string {
  const reason =
    code === "timeout"
      ? "не дождался ответа"
      : code === "not_found"
        ? "не нашёл"
        : code === "disconnected"
          ? "связь с клиентом прервалась"
          : "не получилось";
  switch (intent.kind) {
    case "app.launch":
      return pick([
        `Не вышло открыть ${intent.app}: ${reason}.`,
        `${cap(intent.app)} открыть не удалось — ${reason}.`,
        `Не смог запустить ${intent.app}: ${reason}.`,
      ]);
    case "app.focus":
      return pick([`Не вышло переключиться на ${intent.app}: ${reason}.`, `Не смог перейти в ${intent.app}: ${reason}.`]);
    case "browser.open":
      return pick([`Не вышло открыть страницу: ${reason}.`, `Со страницей не вышло — ${reason}.`]);
    case "media":
      return `Не вышло с воспроизведением: ${reason}.`;
    case "volume":
      return `С громкостью не вышло: ${reason}.`;
    case "clarify":
      return intent.question; // недостижимо, но полнота типа
  }
}
