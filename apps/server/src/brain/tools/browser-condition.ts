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
 * Страница отдала ПУСТОЙ текст по «широкому» селектору (живой эпизод 2026-07-24: Chrome выгрузил
 * фоновую вкладку Деливери → body.textContent = одни пробелы → watch «скажи когда доставят» 35 минут
 * молча отвечал met:false, consecutiveFailures=0 — слепой сенсор маскировался под честное «ещё нет»).
 * Отдельный класс — чтобы вызывающий (watch-probe) классифицировал НЕ-транзиентно: серия таких тиков
 * обязана дойти до dead-watch и ЧЕСТНОГО «не смог наблюдать, приостановил», а не гореть в тишине.
 */
export class BlankPageError extends Error {
  /** Ремонт вкладки был нужен, но упёрся в анти-флаппинг-кулдаун → слепота ВРЕМЕННАЯ (не dead-watch). */
  readonly throttled: boolean;
  constructor(selector: string, throttled = false) {
    super(
      `страница отдала пустой текст по селектору «${selector}» — вкладка выгружена из памяти или не отрендерена` +
        (throttled ? " (починка на кулдауне — повторю на следующей проверке)" : ""),
    );
    this.name = "BlankPageError";
    this.throttled = throttled;
  }
}

/** «Широкие» селекторы, у которых на ЖИВОЙ странице текст пустым не бывает (пусто = вкладка мертва). */
const BROAD_SELECTORS = new Set(["body", "html", ":root", "main", "#root", "#app"]);
const TEXT_PROPS = new Set(["textContent", "innerText"]);

/** Тот же хост? (прежний url пуст → сравнивать не с чем, считаем совместимым). Чистая, без бросков. */
function sameHost(prev: string | undefined, next: string): boolean {
  if (!prev) return true;
  try {
    return new URL(prev).host === new URL(next).host;
  } catch {
    return false;
  }
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
  opts: { recover?: boolean } = {},
): Promise<{ met: boolean; detail: string; value: unknown; patch?: { tabId?: number; url?: string } }> {
  if (!ext.connected) throw new Error("расширение не подключено — браузерное условие не проверить");
  // Дефолт свойства зависит от таргета: медиа-вкладка (нет selector) → currentTime; произвольный
  // selector → textContent (ревью #6: раньше forced 'currentTime' читал div.currentTime=undefined).
  const prop = (cond.prop ?? (cond.selector ? "textContent" : "currentTime")).trim() || "currentTime";
  const useMedia = !cond.selector && MEDIA_PROPS.has(prop);
  // recover (эпизод «перекрыл вкладку» 2026-07-24): разрешаем расширению ПОЧИНИТЬ наблюдаемую вкладку —
  // выгруженную Chrome'ом перезагрузить, закрытую переоткрыть ФОНОВОЙ (без кражи фокуса). Ставит только
  // durable-наблюдение (watch); блокирующий wait_for в петле — НЕ ставит: там страница может быть с
  // недописанной формой пользователя, а reload её потеряет. МЕДИА-условие не чиним никогда (reload
  // сбросил бы позицию, которую условие и ждёт) — отсюда `&& !useMedia`.
  const sel0 = (cond.selector ?? "").trim().toLowerCase();
  const recover = opts.recover === true && !useMedia ? { recover: true } : {};
  // Пустое чтение = слепота ТОЛЬКО для широкого таргета — только для него разрешаем ремонт «по пустоте»
  // (у узкого селектора пусто законно, и reload живой страницы стирал бы работу пользователя — ревью).
  const recoverIfBlank = opts.recover === true && !useMedia && BROAD_SELECTORS.has(sel0) ? { recoverIfBlank: true } : {};
  // 🔴 contains СРАВНИВАЕТСЯ НА СТРАНИЦЕ (ревью 2026-07-24, CRITICAL): наружу расширение отдаёт значение
  // обрезанным (кап 200 симв. — анти-утечка), и серверный includes по обрезку не находил слово дальше
  // 200-го символа — ровно поэтому «доставлен» не срабатывал. Передаём искомую подстроку внутрь.
  const needle = !useMedia && (cond.op ?? "") === "contains" ? { contains: String(cond.value) } : {};
  const data = (await ext.tabAct(
    cond.url ?? "",
    useMedia ? "readMedia" : "getValue",
    useMedia ? { ...recover } : { selector: cond.selector, prop, ...recover, ...recoverIfBlank, ...needle },
    cond.tabId,
  )) as Record<string, unknown>;
  // Вкладка могла быть ПЕРЕОТКРЫТА (новый tabId) — отдаём патч наверх, чтобы наблюдение обновило
  // адресацию. ⚠️ ТОЛЬКО после РЕАЛЬНОГО ремонта (data.recovered) и только когда цель адресуема
  // однозначно: без этого findTargetTab мог подставить чужую вкладку (фолбэк по хосту/активная), и
  // патч НАВСЕГДА переклеил бы наблюдение на чужую страницу с ложным «Сработало» (ревью, CRITICAL).
  const patch: { tabId?: number; url?: string } = {};
  if (typeof data.recovered === "string" && data.recovered) {
    if (typeof data.tabId === "number" && data.tabId !== cond.tabId) patch.tabId = data.tabId;
    // URL пишем, только если хост не изменился (или прежнего url не было) — иначе это другая страница.
    if (typeof data.tabUrl === "string" && data.tabUrl && data.tabUrl !== cond.url && sameHost(cond.url, data.tabUrl)) {
      patch.url = data.tabUrl;
    }
  }
  const withPatch = <T extends object>(r: T): T & { patch?: { tabId?: number; url?: string } } =>
    Object.keys(patch).length > 0 ? { ...r, patch } : r;
  const actual = useMedia ? data[prop] : data.value;
  // Гард честности (ревью #6): значение НЕЧИТАЕМО (нет prop на существующем элементе) ≠ «условие ложно».
  // Для gone это критично — иначе нечитаемое давало met:true (ложное «исчезло/сработало»). Реальное
  // исчезновение элемента идёт по throw-пути (bySelector→not_found→reject), сюда не доходит.
  if (actual === undefined || actual === null) {
    return withPatch({ met: false, detail: `${prop}=— (значение не прочитано; условие: ${cond.op ?? ">="} ${cond.value})`, value: actual });
  }
  // Гард честности (эпизод 2026-07-24): пустой текст ВСЕЙ страницы = слепота сенсора (выгруженная/
  // неотрендеренная вкладка), НЕ валидное «условие не выполнено» — и НЕ «текст исчез» для gone
  // (выгруженная вкладка дала бы ложное «исчезло»). Узкий селектор не трогаем: пустой текст
  // конкретного элемента — легитимное состояние.
  // ⚠️ Пустоту определяем по ПОЛНОЙ длине текста (data.len), а не по отданному наружу значению: при
  // contains-режиме value — это сниппет вокруг совпадения, и его пустота ≠ пустая страница. len приходит
  // от свежего расширения; старое (без len) — прежняя проверка по value (обратная совместимость).
  // blank приходит от расширения ПО TRIM (страница из одних пробелов = выгруженная, ревью 2026-07-24);
  // старое расширение (без поля) — фолбэк на trim() отданного значения.
  const blank = typeof data.blank === "boolean" ? data.blank : typeof actual === "string" && actual.trim() === "";
  if (blank && TEXT_PROPS.has(prop) && BROAD_SELECTORS.has(sel0)) {
    // Пусто ДАЖЕ ПОСЛЕ self-heal (расширение уже перезагрузило/переоткрыло вкладку при recover) —
    // значит сенсор реально слеп: честная ошибка, а не «условие не выполнено». Исключение — ремонт
    // не сработал из-за кулдауна: тогда слепота временная, наблюдение не суспендим (ревью р2 #12).
    throw new BlankPageError(sel0, data.reviveThrottled === true);
  }
  // contains уже посчитан НА СТРАНИЦЕ по ПОЛНОМУ тексту (matched) — используем его, а не сравнение по
  // обрезанному значению (иначе слово дальше 200-го символа не найдётся: первопричина живого эпизода).
  const raw =
    typeof data.matched === "boolean" ? data.matched : compareBrowserValue(actual, cond.op ?? ">=", cond.value);
  const met = cond.gone === true ? !raw : raw;
  const shown = typeof actual === "number" ? Math.round(actual) : String(actual).slice(0, 120);
  const healed = typeof data.recovered === "string" ? ` [вкладка восстановлена: ${data.recovered}]` : "";
  return withPatch({ met, detail: `${prop}=${shown} (условие: ${cond.op ?? ">="} ${cond.value})${healed}`, value: actual });
}
