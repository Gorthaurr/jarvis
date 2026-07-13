/**
 * §Волна2 (2.3) — Слой дешёвых сенсоров: локальный OCR экрана и wait_for (клиентское
 * ожидание события БЕЗ LLM-раундов).
 *
 * screenOcr: Electron снимает экран (полный или кроп-регион) → сайдкар распознаёт текст
 * локально (Windows.Media.Ocr) → ~50-200 токенов текста вместо 1.5-2K-токенного vision-раунда.
 *
 * waitFor: поллинг условия НА КЛИЕНТЕ (UIA-элемент / окно / текст на экране / звук) до
 * наступления или таймаута. Один tool-вызов вместо N раундов «скрин → посмотрел → ещё скрин».
 * ЧЕСТНОСТЬ: таймаут → met:false с внятной причиной (не ошибка транспорта и не ложный успех);
 * met:true — реально наблюдённое состояние (это легитимная сверка).
 */
import type { WaitCondition } from "@jarvis/protocol";
import { createLogger, sleep } from "@jarvis/shared";
import { type CaptureRect, captureScreen } from "./screen.js";
import { ground } from "./ground.js";
import { listWindows } from "./windows.js";
import { NotImplementedError } from "./input.js";
import { sidecar } from "./sidecar-client.js";
import * as system from "./system.js";

const log = createLogger("actuator:sensors");

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrOutcome {
  text: string;
  lines: OcrLine[];
  /** Размер распознанного изображения — bbox строк в ЕГО координатах. */
  width: number;
  height: number;
  /**
   * Маппинг image→screen-DIP кадра OCR (только для ПОЛНОГО снимка без rect; при rect строки уже
   * сдвинуты в систему полного кадра и mapping не отдаём). Потребитель (jarvis SDK find→click)
   * конвертирует центр строки в АБСОЛЮТНЫЕ экранные DIP: boundsX + x/scale → клик space:"screen",
   * не завися от lastMapping. Без него координатный клик по OCR был бы мимо (ложный успех).
   */
  mapping?: { boundsX: number; boundsY: number; scale: number };
}

/** Локальный OCR экрана (полного или региона) через сайдкар. */
export async function screenOcr(which?: string | number, rect?: CaptureRect, lang?: string): Promise<OcrOutcome> {
  if (!sidecar().ready) throw new NotImplementedError("OCR-сайдкар не запущен");
  // updateMapping:false — сенсорный захват не сдвигает систему координат кликов модели (ревью Волны 2).
  const shot = await captureScreen(which, { rect, updateMapping: false });
  const data = (await sidecar().request("ocr", { imageB64: shot.image, lang }, 20_000)) as {
    text?: string;
    lines?: OcrLine[];
  };
  let lines = Array.isArray(data?.lines) ? data.lines : [];
  // Ревью Волны 2: bbox строк OCR — в координатах КРОПА; описание инструмента предлагает кликать
  // по ним (координаты модели = последний ПОЛНЫЙ снимок). Для image-rect сдвигаем к системе
  // полного снимка; для space:"screen"-rect система другая — честно оставляем как есть.
  if (rect && rect.space !== "screen") {
    lines = lines.map((l) => ({ ...l, x: l.x + rect.x, y: l.y + rect.y }));
  }
  // Маппинг image→screen-DIP отдаём ТОЛЬКО для полного кадра (без rect): тогда координаты строк —
  // в системе thumbnail этого захвата, и потребитель может конвертировать их в абсолютные DIP.
  // При rect строки уже сдвинуты в иную систему → mapping не соответствует, не отдаём (SDK не кликает).
  const mapping = !rect && shot.mapping ? { boundsX: shot.mapping.boundsX, boundsY: shot.mapping.boundsY, scale: shot.mapping.scale } : undefined;
  return {
    text: String(data?.text ?? ""),
    lines,
    width: shot.width,
    height: shot.height,
    mapping,
  };
}

export interface WaitOutcome {
  met: boolean;
  elapsedMs: number;
  polls: number;
  /** Что реально наблюдали в последний опрос (для честного отчёта модели). */
  detail: string;
  /**
   * Только для kind:"gsi" (ревью фиксов, 2-й проход R4): состояние источника в последний опрос —
   * fresh (пушит) / stale (запись есть, но протухла — вкл. старше окна recentlyGone) / none (записи
   * нет: не пушил или клиент перезапущен). Серверный watch по нему ведёт STATEFUL-детект исчезновения
   * («видел живым в рамках этого наблюдения → теперь stale = исчез»), не завися от лотереи
   * «попал ли редкий тик в окно recentlyGone».
   */
  gsiState?: "fresh" | "stale" | "none";
}

const WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_MAX_TIMEOUT_MS = 120_000;

/** Дефолтный шаг опроса по типу условия: OCR тяжелее UIA/окон — реже. */
function defaultPollMs(cond: WaitCondition): number {
  if (cond.kind === "gsi") return 400; // локальная память процесса — почти бесплатно
  return cond.kind === "text" ? 1_200 : 600;
}

/** Валидация условия ДО поллинга — непригодное условие валится сразу честной ошибкой. */
function validateCondition(cond: WaitCondition): void {
  if (cond.kind === "window" && !(cond.titleContains ?? "").trim() && !(cond.process ?? "").trim()) {
    throw new Error("wait_for window: нужен titleContains и/или process");
  }
  if (cond.kind === "text" && !cond.text.trim()) throw new Error("wait_for text: пустой текст");
}

/** Один опрос условия → [выполнено?, что видели, gsi-состояние?]. Сенсорные сбои НЕ бросают (описываются в detail). */
async function checkOnce(cond: WaitCondition): Promise<[boolean, string, WaitOutcome["gsiState"]?]> {
  switch (cond.kind) {
    case "ui": {
      // Ревью Волны 2: лежащий сайдкар ≠ «элемент исчез» — gone:true при недоступном сенсоре
      // давал бы ЛОЖНЫЙ met:true. Недоступность — честное «не выполнено» с причиной в detail.
      if (!sidecar().ready) return [false, "сайдкар недоступен — UIA-условие не проверить"];
      try {
        const g = await ground({ role: cond.role, name: cond.name, nameMode: cond.nameMode });
        return [!cond.gone, `элемент найден (handle=${g.handle})`];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Различаем «не найден» (легитимный исход для gone) и сбой сенсора (RPC/таймаут).
        if (/не найден|пустой handle/iu.test(msg)) return [Boolean(cond.gone), "элемент не найден"];
        return [false, `сбой UIA-опроса: ${msg}`];
      }
    }
    case "window": {
      const title = (cond.titleContains ?? "").trim().toLowerCase();
      const proc = (cond.process ?? "").trim().toLowerCase();
      const wins = await listWindows();
      const hit = wins.find(
        (w) =>
          (!title || w.title.toLowerCase().includes(title)) &&
          (!proc || w.process.toLowerCase().includes(proc)),
      );
      const present = Boolean(hit);
      return [cond.gone ? !present : present, hit ? `окно «${hit.title}» (${hit.process})` : "окна нет"];
    }
    case "text": {
      const needle = cond.text.trim().toLowerCase();
      const ocr = await screenOcr(cond.monitor, cond.rect as CaptureRect | undefined);
      const found = ocr.text.toLowerCase().includes(needle);
      const seen = ocr.text.replace(/\s+/g, " ").trim();
      const detail = found ? "текст найден" : `текста нет (видно: «${seen.slice(0, 120)}${seen.length > 120 ? "…" : ""}»)`;
      return [cond.gone ? !found : found, detail];
    }
    case "sound": {
      const r = await system.runSystem({ kind: "system.media", op: "state" });
      const playing = Boolean(r.playing);
      return [playing === cond.playing, `звук ${playing ? "идёт" : "не идёт"} (peak=${r.peak ?? 0})`];
    }
    case "gsi": {
      // §Волна3 (3.4): состояние, запушенное программой на локальный GSI-листенер (Dota GSI и т.п.).
      const { gsiValue } = await import("../sensors/gsi-listener.js");
      const got = gsiValue(cond.source, cond.path);
      if (!got) return [false, `GSI: источник «${cond.source ?? "default"}» ещё ничего не пушил`, "none"];
      if (!got.fresh) {
        // §Волна3 ревью (#13): источник ЗАМОЛЧАЛ (игра закрыта) = значение ИСЧЕЗЛО. Для gone:true это и
        // есть выполнение условия («скажи, когда матч закончится» → пуши прекратились → met). Раньше
        // ранний return [false] стоял ДО инверсии gone → one-shot молчал вечно. Для обычного (ждём
        // появления/значения) — честный «не выполнено», как прежде. (!got «никогда не пушил» ≠ исчезновение.)
        // Ревью фиксов (#3): «исчез» засчитывается ТОЛЬКО недавнему протуханию (recentlyGone, окно
        // ~4×STALE_MS в листенере) — стор без TTL хранит запись прошлой сессии часами, и gone-условие,
        // поставленное ПОСЛЕ закрытия игры, мгновенно давало ложный met («матч закончился» до его начала).
        if (got.recentlyGone) return [cond.gone === true, "GSI: источник замолчал (протух) — значение исчезло", "stale"];
        return [false, "GSI: запись давно протухла — источник молчит с прошлой сессии (данных нет)", "stale"];
      }
      const v = got.value === undefined ? "" : String(got.value);
      // Ревью фиксов (#9): критерий коэрсим в строку — watch-предикат мог принести boolean/number
      // (equals:true для boolean-поля GSI-JSON); строгое v === true не матчилось бы никогда.
      const wantEquals = cond.equals !== undefined ? String(cond.equals) : undefined;
      const wantContains = cond.contains !== undefined ? String(cond.contains) : undefined;
      const matched =
        wantEquals !== undefined ? v === wantEquals : wantContains !== undefined ? v.toLowerCase().includes(wantContains.toLowerCase()) : v !== "";
      const detail = `GSI ${cond.path} = «${v.slice(0, 80)}»`;
      return [cond.gone === true ? !matched : matched, detail, "fresh"];
    }
    default: {
      const _exhaustive: never = cond;
      throw new Error(`wait_for: неизвестное условие ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Дождаться условия поллингом. Первый опрос — сразу (условие уже выполнено → мгновенный ответ).
 * Сбой отдельного опроса (сайдкар моргнул) не роняет ожидание — считается «не выполнено».
 */
export async function waitFor(cond: WaitCondition, timeoutMs?: number, pollMs?: number): Promise<WaitOutcome> {
  validateCondition(cond); // непригодное условие — честная ошибка СРАЗУ, не 30с пустого ожидания
  const timeout = Math.min(WAIT_MAX_TIMEOUT_MS, Math.max(1_000, timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS));
  const poll = Math.max(150, pollMs ?? defaultPollMs(cond));
  const startedAt = Date.now();
  let polls = 0;
  let detail = "";
  let gsiState: WaitOutcome["gsiState"];
  log.info("wait.for", { kind: cond.kind, timeout, poll });

  for (;;) {
    polls += 1;
    try {
      const [met, seen, state] = await checkOnce(cond);
      detail = seen;
      if (state) gsiState = state; // R4: состояние источника последнего опроса — серверному watch
      if (met) return { met: true, elapsedMs: Date.now() - startedAt, polls, detail, ...(gsiState ? { gsiState } : {}) };
    } catch (e) {
      // Транзиентный сбой сенсора (в т.ч. на ПЕРВОМ опросе, ревью Волны 2) не роняет ожидание —
      // условие могло ещё не наступить; сбой виден в detail, честный met:false по таймауту.
      detail = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() - startedAt + poll > timeout) {
      return { met: false, elapsedMs: Date.now() - startedAt, polls, detail, ...(gsiState ? { gsiState } : {}) };
    }
    await sleep(poll);
  }
}
