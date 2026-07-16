/**
 * Оценка BROWSER-условия wait_for/watch на СЕРВЕРЕ (fix 2026-07-15). Расширение «руки в браузере»
 * подключено к серверу (/ext), а НЕ к клиенту-Electron — поэтому условие «видео дошло до N секунд»
 * (video.currentTime) читается тут через ext-мост, а не хрупким OCR таймера на экране клиента.
 *
 * Используется в двух местах: (1) dispatch.wait_for — блокирующий поллинг в петле агента
 * («жди пока видео дойдёт до 26:00 → перемотай»); (2) watch.checkPredicate — одна проверка на тик
 * (durable-наблюдение). Чистое сравнение `compareBrowserValue` тестируется отдельно.
 */
import type { WaitCondition } from "@jarvis/protocol";

/** BROWSER-подтип WaitCondition. */
export type BrowserCondition = Extract<WaitCondition, { kind: "browser" }>;

/** Мост-подмножество для чтения значения из вкладки (совпадает с ToolContext.ext / ExtensionBridge). */
export interface BrowserReader {
  readonly connected: boolean;
  tabAct(url: string, intent: string, params?: Record<string, unknown>, tabId?: number, refMode?: boolean): Promise<unknown>;
}

/** Числовые свойства медиа читаются дешёвым интентом readMedia; прочее — обобщённым getValue. */
const MEDIA_PROPS = new Set(["currentTime", "duration", "paused"]);

export function isBrowserCondition(v: unknown): v is BrowserCondition {
  return Boolean(v) && typeof v === "object" && (v as { kind?: unknown }).kind === "browser";
}

/**
 * Сравнить фактическое значение из DOM с ожидаемым по оператору (ЧИСТАЯ функция — тестируется).
 * Числовые операторы приводят обе стороны к числу; `contains`/`==`/`!=` сравнивают как строки
 * (paused:true/false тоже через строку). Нечисловой вход для числового оператора → false (честно «нет»).
 */
export function compareBrowserValue(
  actual: unknown,
  op: BrowserCondition["op"],
  expected: string | number | boolean,
): boolean {
  if (actual === undefined || actual === null) return false;
  if (op === "contains") return String(actual).toLowerCase().includes(String(expected).toLowerCase());
  if (op === "==") return String(actual) === String(expected);
  if (op === "!=") return String(actual) !== String(expected);
  const a = typeof actual === "number" ? actual : Number(actual);
  const b = typeof expected === "number" ? expected : Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  switch (op) {
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case "<":
      return a < b;
    default:
      return a >= b; // ">=" и дефолт (для чисел «дошло до/превысило» — самый частый кейс видео)
  }
}

/**
 * Прочитать значение из вкладки пользователя и сравнить с условием. Учитывает gone (инверсия).
 * Ошибка чтения (расширение не подключено / вкладки нет / нет media) → бросаем — вызывающий решает
 * (для wait_for-петли это «ещё не дождались», для watch — транзиентная ошибка тика).
 */
export async function evalBrowserCondition(
  ext: BrowserReader,
  cond: BrowserCondition,
): Promise<{ met: boolean; detail: string; value: unknown }> {
  if (!ext.connected) throw new Error("расширение не подключено — браузерное условие не проверить");
  // Дефолт свойства зависит от таргета: медиа-вкладка (нет selector) → currentTime; произвольный
  // selector → textContent (ревью #6: раньше forced 'currentTime' читал div.currentTime=undefined).
  const prop = (cond.prop ?? (cond.selector ? "textContent" : "currentTime")).trim() || "currentTime";
  const useMedia = !cond.selector && MEDIA_PROPS.has(prop);
  const data = (await ext.tabAct(
    cond.url ?? "",
    useMedia ? "readMedia" : "getValue",
    useMedia ? {} : { selector: cond.selector, prop },
    cond.tabId,
  )) as Record<string, unknown>;
  const actual = useMedia ? data[prop] : data.value;
  // Гард честности (ревью #6): значение НЕЧИТАЕМО (нет prop на существующем элементе) ≠ «условие ложно».
  // Для gone это критично — иначе нечитаемое давало met:true (ложное «исчезло/сработало»). Реальное
  // исчезновение элемента идёт по throw-пути (bySelector→not_found→reject), сюда не доходит.
  if (actual === undefined || actual === null) {
    return { met: false, detail: `${prop}=— (значение не прочитано; условие: ${cond.op ?? ">="} ${cond.value})`, value: actual };
  }
  const raw = compareBrowserValue(actual, cond.op ?? ">=", cond.value);
  const met = cond.gone === true ? !raw : raw;
  const shown = typeof actual === "number" ? Math.round(actual) : String(actual).slice(0, 120);
  return { met, detail: `${prop}=${shown} (условие: ${cond.op ?? ">="} ${cond.value})`, value: actual };
}
