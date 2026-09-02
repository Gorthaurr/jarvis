/**
 * §Волна2 (2.1) — Fused act+observe: ДЕШЁВОЕ наблюдение сразу после действия, в ТОТ ЖЕ ответ.
 *
 * Корень экономики (план 2026-07-10, Д1): паттерн «клик → отдельный LLM-раунд со скрином →
 * снова клик» удваивал число раундов. Теперь актуатор сам прикладывает наблюдение к
 * ActionResult.data.observation, сервер (dispatch) кладёт его в тот же tool_result и снимает
 * verify-долг БЕЗ отдельного раунда.
 *
 * Лестница наблюдения (дешёвое → дорогое):
 *   1) a11y-выжимка АКТИВНОГО окна (сайдкар read.window, ~сотни токенов текста);
 *   2) окно UIA-слепое (игра/canvas: выжимка пустая) → локальный OCR региона вокруг точки
 *      действия (или всего экрана) — текст пикселей без vision-раунда.
 * Ничего не вышло (сайдкар лежит/таймаут) → undefined: действие возвращается КАК РАНЬШЕ,
 * verify-петля сервера потребует отдельную сверку (честная деградация, не ложный успех).
 *
 * ЧЕСТНОСТЬ: наблюдение — реальное состояние ПОСЛЕ действия (со стабилизационной паузой),
 * а не эхо намерения. Пустой экран честно помечается, не выдумывается.
 */
import { createLogger, sleep } from "@jarvis/shared";
import { sidecar } from "./sidecar-client.js";

const log = createLogger("actuator:observe");

export interface Observation {
  /** Каким сенсором смотрели: a11y (UIA-выжимка окна) | ocr (локальный OCR пикселей). */
  via: "a11y" | "ocr";
  /** Заголовок активного окна (контекст для модели). */
  window?: string;
  /** Что реально видно (усечено). */
  text: string;
  /**
   * Ревью Волны 2: СЛАБОЕ наблюдение (OCR ничего не распознал) — информация для модели есть,
   * но verify-долг оно НЕ снимает (dispatch не ставит observed): «ничего не видно» ≠ сверка исхода.
   */
  weak?: boolean;
  /**
   * Форензика 2026-09-01: наблюдение-ДЕЛЬТА («появилось/исчезло») против прежнего описания окна.
   * `changed:false` = структурных изменений нет: это НЕ доказательство провала, но и не сверка
   * исхода — verify-долг такое наблюдение не снимает.
   */
  delta?: boolean;
  changed?: boolean;
}

/** Снимок структуры окна ДО действия — база для дельты. */
export interface UiFingerprint {
  title?: string;
  /** Строки a11y-выжимки: одна строка = один элемент («Button: Отправить [значение]»). */
  lines: string[];
  /**
   * PID окна, с которого снят снимок. Снимок ПОСЛЕ читается по ТОМУ ЖЕ pid: `read.window` без него
   * идёт от элемента с ФОКУСОМ, а фокус переезжает от почти любого клика — и дельта считалась между
   * разными деревьями (адверс-ревью, HIGH).
   */
  pid?: number;
  /**
   * Нормализованные формы строк, которые меняются САМИ, без нашего действия (таймер плеера, часы,
   * счётчик загрузки) — ИЗМЕРЕНО двумя чтениями подряд, а не угадано по наличию цифр.
   * Зачем: лексическое правило «поменялись только цифры → это таймер» ложно гасило РЕЗУЛЬТАТ
   * действия, когда результат и есть число (номер страницы, сумма в поле, количество).
   */
  selfChanging?: string[];
}

export interface UiDelta {
  appeared: string[];
  disappeared: string[];
  titleFrom?: string;
  titleTo?: string;
  /** Есть ли СОДЕРЖАТЕЛЬНОЕ изменение (изменения только в цифрах/таймерах не считаются). */
  changed: boolean;
  /** Изменения были, но чисто волатильные (таймер плеера, счётчик) — их видно, но они не доказывают исход. */
  volatileOnly: boolean;
  /**
   * 🔴 Снимки СОПОСТАВИМЫ (адверс-ревью 2026-09-01, HIGH). Сайдкарный `read.window` читает поддерево
   * ЭЛЕМЕНТА С ФОКУСОМ, а фокус переезжает от почти любого клика — и «до»/«после» оказываются РАЗНЫМИ
   * деревьями. Их разница выглядит как мощнейшее изменение и снимала verify-долг на действии, которое
   * могло промахнуться. Несопоставимые снимки сверкой не считаются НИКОГДА.
   */
  comparable: boolean;
}

/**
 * Доля общих строк, ниже которой считаем, что смотрим ДРУГОЕ дерево (сменился фокус/окно), а не
 * изменение того же. 0.2 выбран консервативно: настоящая перерисовка диалога внутри окна почти
 * всегда сохраняет каркас (меню, заголовки, статусбар), а подмена поддерева — нет.
 */
const MIN_OVERLAP = 0.2;
/** Ниже этого числа элементов снимок слишком мал, чтобы судить о подмене поддерева (см. diffFingerprints). */
const MIN_LINES_FOR_OVERLAP = 4;

/** Выключатель fused-наблюдения (диагностика/откат): JARVIS_FUSED_OBSERVE=0. */
function enabled(): boolean {
  return (process.env.JARVIS_FUSED_OBSERVE ?? "1") !== "0";
}

/** Пауза стабилизации UI после действия — экран должен успеть перерисоваться. */
const DEFAULT_SETTLE_MS = 350;
/** Кап выжимки: наблюдение — дешёвая сверка, не полный дамп окна. */
const TEXT_CAP = 900;
/** Короче этого a11y-текст считаем «окно UIA-слепое» → OCR-фолбэк. */
const MIN_A11Y_CHARS = 40;
/** Регион OCR вокруг точки действия (DIP): достаточно для кнопки/диалога, дешевле полного экрана. */
const OCR_REGION_W = 560;
const OCR_REGION_H = 340;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP - 1)}…` : t;
}

/** Сколько строк дельты показываем в каждую сторону (наблюдение — сводка, не дамп). */
const DELTA_MAX_LINES = 10;
/** Кап строк снимка: защита от гигантского дерева (дельта считается по множествам). */
const FINGERPRINT_MAX_LINES = 400;
/** Кап символов выжимки для снимка: дельта считается по структуре, а не по полному дампу. */
const FINGERPRINT_MAX_CHARS = 8000;

/** Разбить выжимку на строки-элементы. ЧИСТАЯ функция. */
export function splitDigest(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, FINGERPRINT_MAX_LINES);
}

/**
 * Нормализация для решения «содержательное ли изменение»: цифровые серии схлопываются.
 * Зачем: у плеера строка таймера («Text: 7:28») меняется САМА, без нашего действия. Без этого
 * КАЖДОЕ наблюдение над видео возвращало бы changed:true — то есть выдавало бы ход времени за
 * результат клика. Это ровно ложный успех, только упакованный в дельту.
 */
export function normalizeVolatile(line: string): string {
  return line.replace(/\d+/g, "#");
}

/** Мультимножество строк (одинаковые элементы встречаются много раз — терять их нельзя). */
function counts(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

/** Разница мультимножеств: что есть в a сверх b. */
function excess(a: string[], b: string[]): string[] {
  const bc = counts(b);
  const out: string[] = [];
  for (const l of a) {
    const left = bc.get(l) ?? 0;
    if (left > 0) bc.set(l, left - 1);
    else out.push(l);
  }
  return out;
}

/** Дельта двух снимков. ЧИСТАЯ функция — на ней держится честность наблюдения. */
export function diffFingerprints(before: UiFingerprint, after: UiFingerprint): UiDelta {
  const appeared = excess(after.lines, before.lines);
  const disappeared = excess(before.lines, after.lines);
  // Заголовок меряем ТОЙ ЖЕ меркой, что и строки (ревью, HIGH): у плеера/загрузки таймер стоит и в
  // заголовке («7:28 — VLC»), и раньше он ОДИН пробивал фильтр волатильности, объявляя ход времени
  // изменением и снимая verify-долг с промахнувшегося клика.
  const titleChanged = normalizeVolatile(before.title ?? "") !== normalizeVolatile(after.title ?? "");
  const titleShown = (before.title ?? "") !== (after.title ?? "");
  // Волатильность. ГЛАВНЫЙ путь — ИЗМЕРЕННЫЙ: строки, которые менялись сами (до всякого действия).
  // Он различает таймер плеера и НОМЕР СТРАНИЦЫ: лексическое правило «поменялись только цифры»
  // гасило второе как «фон» и объявляло сработавшее действие не дошедшим (адверс-ревью).
  const appNorm = appeared.map(normalizeVolatile).sort();
  const disNorm = disappeared.map(normalizeVolatile).sort();
  // 🔴 ПУСТОЙ ЗАМЕР — ЭТО ОТСУТСТВИЕ ДАННЫХ, А НЕ «в окне ничего не тикает» (адверс-ревью, HIGH).
  // Окно пробы (160мс) короче периода типового тикера (секунда), поэтому чаще всего тик в него не
  // попадает. Считать такой замер доказательством стабильности значило ОТКЛЮЧИТЬ фильтр таймера
  // ровно там, где он и нужен: следующий тик становился «содержательным изменением» и снимал
  // verify-долг с промахнувшегося клика. Замер ДОБАВЛЯЕТ знание, но не отменяет лексический гард:
  // волатильно то, что подтвердил ЛЮБОЙ из них.
  const measured = before.selfChanging;
  const haveMeasurement = measured !== undefined && measured.length > 0;
  const lexicalSaysVolatile =
    appeared.length > 0 && appNorm.length === disNorm.length && appNorm.every((v, i) => v === disNorm[i]);
  const volatileOnly =
    appeared.length + disappeared.length > 0 &&
    (haveMeasurement
      ? // Замер СОСТОЯЛСЯ (что-то поймали) — он и решает: изменение волатильно, только если КАЖДАЯ
        // изменившаяся строка была среди самоменяющихся. Так «Стр. 1 → Стр. 2» остаётся результатом.
        [...appNorm, ...disNorm].every((v) => measured.includes(v))
      : // Замера НЕТ (не удался или ничего не поймал за 160мс — тик секундного таймера туда чаще
        // всего не попадает) — это НЕЗНАНИЕ, а не «тут ничего не тикает». Остаёмся на консервативной
        // лексике: лишний раунд сверки дешевле ложного «сделано» на промахнувшемся клике.
        lexicalSaysVolatile);
  // Сопоставимость: сколько строк «до» уцелело в «после».
  // ⚠️ Судим об этом ТОЛЬКО на достаточно больших снимках: у окна из двух-трёх элементов полная
  // смена строк — это штатный результат действия (поле было пустым, стало заполненным), и объявлять
  // такую дельту «несравнимой» значило бы глушить верную сверку. Подмена поддерева/окна опознаётся
  // на реальных деревьях (десятки строк), где каркас переживает любую перерисовку.
  const kept = before.lines.length - disappeared.length;
  const overlap = before.lines.length === 0 ? 0 : kept / before.lines.length;
  const bigEnough = before.lines.length >= MIN_LINES_FOR_OVERLAP && after.lines.length >= MIN_LINES_FOR_OVERLAP;
  const comparable = !bigEnough || overlap >= MIN_OVERLAP;
  return {
    appeared,
    disappeared,
    titleFrom: titleShown ? before.title : undefined,
    titleTo: titleShown ? after.title : undefined,
    // Несопоставимые снимки не дают ПОЛОЖИТЕЛЬНОГО вывода об исходе ни при каких изменениях.
    changed: comparable && !volatileOnly && (titleChanged || appeared.length > 0 || disappeared.length > 0),
    volatileOnly,
    comparable,
  };
}

/** Человекочитаемая дельта для модели. ЧИСТАЯ функция. */
export function formatDelta(d: UiDelta): string {
  const parts: string[] = [];
  if (d.titleTo !== undefined) parts.push(`окно: «${d.titleFrom ?? "?"}» → «${d.titleTo}»`);
  const list = (arr: string[], sign: string) => {
    for (const l of arr.slice(0, DELTA_MAX_LINES)) parts.push(`${sign} ${l}`);
    if (arr.length > DELTA_MAX_LINES) parts.push(`${sign} …и ещё ${arr.length - DELTA_MAX_LINES}`);
  };
  list(d.appeared, "+");
  list(d.disappeared, "−");
  if (parts.length === 0) {
    return (
      "структурных изменений в окне НЕ ВИДНО. Это не доказывает ни успех, ни провал: " +
      "проверь целевой признак (значение поля, состояние, появившийся элемент) прицельно."
    );
  }
  if (!d.comparable) {
    parts.push(
      "⚠️ СРАВНИВАТЬ НЕ С ЧЕМ: до и после смотрели РАЗНЫЕ места (сменились окно или фокус) — " +
        "это не сверка исхода, проверь цель прицельно.",
    );
  } else if (d.volatileOnly) {
    parts.push(
      "⚠️ изменились только ЧИСЛА (это может быть и таймер сам по себе, и результат действия — " +
        "например перемотка или номер страницы). Исход не подтверждён: сверь целевое значение прицельно.",
    );
  }
  return parts.join("\n");
}

/**
 * Снимок структуры активного окна ДО действия. Дёшево (та же выжимка, что и после), короткий
 * бюджет: без снимка наблюдение просто вернётся в прежнем режиме «описание окна».
 */
export async function captureUiFingerprint(): Promise<UiFingerprint | undefined> {
  if (!enabled() || !sidecar().ready) return undefined;
  // Бюджет РАВЕН бюджету снимка ПОСЛЕ (ревью, HIGH): работа одна и та же, а асимметрия 2с/4с давала
  // класс окон (тяжёлое дерево Steam/Chromium), где «до» систематически не успевал — задержку перед
  // действием платили, а дельту не получали, и это было невидимо.
  const t0 = Date.now();
  const fp = await withBudget(
    (async () => {
      // Целевое окно фиксируем ЯВНО: снимок ПОСЛЕ читается по этому же pid, даже если фокус уехал.
      const fg = await foregroundWindow();
      const first = await readDigest(fg?.pid);
      if (!first) return undefined;
      const lines = splitDigest(first);
      // Волатильность ИЗМЕРЯЕМ, а не угадываем: второе чтение выявляет строки, меняющиеся сами.
      // Платим за него ТОЛЬКО когда есть чему тикать (в снимке вообще есть числа) — иначе вопроса нет.
      const selfChanging = lines.some(hasDigits) ? await measureSelfChanging(lines, fg?.pid) : undefined;
      return { title: fg?.title, pid: fg?.pid, lines, selfChanging };
    })(),
    5_500,
  );
  if (!fp) log.debug(`observe: снимок ДО не получен за ${Date.now() - t0}мс — наблюдение будет без дельты`);
  return fp;
}

/** Есть ли в строке цифры (дёшево: гейт на измерение волатильности). ЧИСТАЯ функция. */
export function hasDigits(line: string): boolean {
  return /\d/.test(line);
}

/** Пауза между двумя чтениями при измерении самоизменяемости. */
const VOLATILITY_PROBE_MS = 160;

/** Прочитать выжимку окна (по pid — или активного, если pid неизвестен). */
async function readDigest(pid?: number): Promise<string | undefined> {
  try {
    const data = (await sidecar().request(
      "read.window",
      { pid, maxChars: FINGERPRINT_MAX_CHARS },
      4_000,
    )) as { text?: string };
    const text = String(data?.text ?? "").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Какие строки меняются САМИ: читаем окно второй раз через короткую паузу, БЕЗ всякого действия.
 * Всё, что успело измениться за это время, — фон (таймер, часы, прогресс), и его изменение после
 * нашего действия ничего не доказывает. Возвращаем нормализованные формы.
 */
async function measureSelfChanging(lines: string[], pid?: number): Promise<string[] | undefined> {
  await sleep(VOLATILITY_PROBE_MS);
  const second = await readDigest(pid);
  if (!second) return undefined;
  const after = splitDigest(second);
  const changed = new Set<string>();
  for (const l of excess(lines, after)) changed.add(normalizeVolatile(l));
  for (const l of excess(after, lines)) changed.add(normalizeVolatile(l));
  return [...changed];
}

/** Переднее окно: pid + заголовок (best-effort). */
async function foregroundWindow(): Promise<{ pid?: number; title?: string } | undefined> {
  try {
    const { listWindows } = await import("./windows.js");
    const w = (await listWindows()).find((x) => x.foreground);
    return w ? { pid: w.pid, title: w.title } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Заголовок окна НАБЛЮДАЕМОГО процесса (а не текущего переднего).
 *
 * 🔴 Адверс-ревью (HIGH): строки читались по pid, а заголовок брался у переднего окна — и клик,
 * промахнувшийся в ЧУЖОЕ окно, давал «изменение заголовка» наблюдаемого окна, снимая verify-долг.
 * `gone:true` = окна этого процесса больше нет: сравнивать не с чем, а не «всё поменялось».
 */
async function titleOfPid(pid?: number): Promise<{ title?: string; gone: boolean }> {
  if (pid === undefined) {
    const fg = await foregroundWindow();
    return { title: fg?.title, gone: false };
  }
  try {
    const { listWindows } = await import("./windows.js");
    const list = await listWindows();
    const own = list.filter((w) => w.pid === pid);
    if (own.length === 0) return { gone: true };
    return { title: (own.find((w) => w.foreground) ?? own[0])!.title, gone: false };
  } catch {
    return { gone: false };
  }
}

/** Заголовок активного окна (best-effort, не роняет наблюдение). */
async function foregroundTitle(): Promise<string | undefined> {
  try {
    const { listWindows } = await import("./windows.js");
    const wins = await listWindows();
    return wins.find((w) => w.foreground)?.title;
  } catch {
    return undefined;
  }
}

/**
 * Жёсткий бюджет наблюдения (ревью Волны 2): серверный actionTimeoutMs у input-команд — 15с;
 * хвост наблюдения (a11y до 4с + OCR до 20с) мог его пробить → УСПЕШНЫЙ клик рапортовался бы
 * таймаутом, а ретрай модели ПОВТОРИЛ бы действие. Не уложились — честно без наблюдения.
 */
const OBSERVE_BUDGET_MS = 6_000;

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

/**
 * Снять дешёвое наблюдение после действия. clickPoint — экранные DIP-координаты действия
 * (для OCR-региона); settleMs — пауза стабилизации (клик 350мс, печать 150мс).
 * undefined = наблюдение недоступно (вызывающий возвращает результат без него).
 * ⚠️ Известное ограничение: смотрим АКТИВНОЕ окно — фоновое ui.invoke по handle другого окна
 * наблюдается «не тем» окном; заголовок окна в наблюдении виден модели — ей и сверять.
 */
export async function observeAfterAction(opts?: {
  settleMs?: number;
  clickPoint?: { x: number; y: number };
  /** Снимок ДО действия (captureUiFingerprint) — включает режим дельты. */
  before?: UiFingerprint;
}): Promise<Observation | undefined> {
  if (!enabled() || !sidecar().ready) return undefined;
  return withBudget(observeInner(opts), OBSERVE_BUDGET_MS + (opts?.settleMs ?? DEFAULT_SETTLE_MS));
}

async function observeInner(opts?: {
  settleMs?: number;
  clickPoint?: { x: number; y: number };
  before?: UiFingerprint;
}): Promise<Observation | undefined> {
  try {
    await sleep(opts?.settleMs ?? DEFAULT_SETTLE_MS);

    // Ступень 1: a11y-выжимка окна (дёшево; для обычных приложений — достаточно).
    // Просим БОЛЬШЕ символов, когда считаем дельту: сравниваем структуру, а не показываем дамп.
    // 🔴 Читаем ТО ЖЕ окно, что и снимок ДО (по pid): без этого фокус, уехавший от нашего же клика,
    // подменял корень выжимки, и «разница» была разницей РАЗНЫХ деревьев (адверс-ревью, HIGH).
    const wantChars = opts?.before ? FINGERPRINT_MAX_CHARS : TEXT_CAP + 200;
    let a11yText = "";
    try {
      const data = (await sidecar().request(
        "read.window",
        { pid: opts?.before?.pid, maxChars: wantChars },
        4_000,
      )) as { text?: string };
      a11yText = String(data?.text ?? "").trim();
    } catch (e) {
      log.debug(`observe: a11y-выжимка не удалась (${e instanceof Error ? e.message : String(e)})`);
    }
    if (a11yText.length >= MIN_A11Y_CHARS) {
      // Заголовок берём у ТОГО ЖЕ окна, что и строки (см. titleOfPid): смешение источников давало
      // «изменение» наблюдаемого окна из заголовка ЧУЖОГО.
      const seen = opts?.before ? await titleOfPid(opts.before.pid) : { title: await foregroundTitle(), gone: false };
      const title = seen.title;
      // 🔴 ДЕЛЬТА (форензика 2026-09-01). Прежнее наблюдение отдавало ОПИСАНИЕ окна — оно не
      // отвечало на вопрос verify-долга «изменилось ли то, что я хотел», и модель добирала
      // уверенность единственным средством, которому доверяет: скриншотом. В логах это видно
      // прямо: пара «screen_capture → input_click» — самая частая во всём датасете (57 раз),
      // 41% раундов с кликом требовали скрина следующим раундом.
      if (opts?.before) {
        const d = diffFingerprints(opts.before, { title, lines: splitDigest(a11yText) });
        // Окно наблюдаемого процесса исчезло — сравнивать не с чем (это НЕ «всё изменилось»).
        if (seen.gone) {
          return {
            via: "a11y",
            window: title,
            text: "окно наблюдаемого приложения ИСЧЕЗЛО (закрылось или сменился процесс) — сравнивать не с чем, исход не подтверждён: сверь прицельно.",
            delta: true,
            changed: false,
            weak: true,
          };
        }
        return {
          via: "a11y",
          window: title,
          text: formatDelta(d),
          delta: true,
          changed: d.changed,
          // «Ничего не изменилось» и «поменялись только цифры» — НЕ сверка исхода.
          weak: !d.changed,
        };
      }
      return { via: "a11y", window: title, text: clip(a11yText) };
    }

    // Ступень 2: UIA-слепое окно (игра/canvas) → локальный OCR региона вокруг точки действия.
    const { screenOcr } = await import("./sensors-cheap.js");
    const rect = opts?.clickPoint
      ? {
          x: opts.clickPoint.x - OCR_REGION_W / 2,
          y: opts.clickPoint.y - OCR_REGION_H / 2,
          w: OCR_REGION_W,
          h: OCR_REGION_H,
          space: "screen" as const,
        }
      : undefined;
    const ocr = await screenOcr("active", rect);
    const text = ocr.text.trim();
    // Пустой OCR — СЛАБОЕ наблюдение (weak): модель видит «пусто», но verify-долг не снимается
    // (ревью Волны 2: «ничего не распознано» — не подтверждение исхода).
    if (!text) {
      return {
        via: "ocr",
        window: await foregroundTitle(),
        text: "(распознаваемого текста в области действия не видно)",
        weak: true,
      };
    }
    return { via: "ocr", window: await foregroundTitle(), text: clip(text) };
  } catch (e) {
    log.debug(`observe: наблюдение недоступно (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}
