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
  return {
    text: String(data?.text ?? ""),
    lines,
    width: shot.width,
    height: shot.height,
  };
}

export interface WaitOutcome {
  met: boolean;
  elapsedMs: number;
  polls: number;
  /** Что реально наблюдали в последний опрос (для честного отчёта модели). */
  detail: string;
}

const WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_MAX_TIMEOUT_MS = 120_000;

/** Дефолтный шаг опроса по типу условия: OCR тяжелее UIA/окон — реже. */
function defaultPollMs(cond: WaitCondition): number {
  return cond.kind === "text" ? 1_200 : 600;
}

/** Валидация условия ДО поллинга — непригодное условие валится сразу честной ошибкой. */
function validateCondition(cond: WaitCondition): void {
  if (cond.kind === "window" && !(cond.titleContains ?? "").trim() && !(cond.process ?? "").trim()) {
    throw new Error("wait_for window: нужен titleContains и/или process");
  }
  if (cond.kind === "text" && !cond.text.trim()) throw new Error("wait_for text: пустой текст");
}

/** Один опрос условия → [выполнено?, что видели]. Сенсорные сбои НЕ бросают (описываются в detail). */
async function checkOnce(cond: WaitCondition): Promise<[boolean, string]> {
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
  log.info("wait.for", { kind: cond.kind, timeout, poll });

  for (;;) {
    polls += 1;
    try {
      const [met, seen] = await checkOnce(cond);
      detail = seen;
      if (met) return { met: true, elapsedMs: Date.now() - startedAt, polls, detail };
    } catch (e) {
      // Транзиентный сбой сенсора (в т.ч. на ПЕРВОМ опросе, ревью Волны 2) не роняет ожидание —
      // условие могло ещё не наступить; сбой виден в detail, честный met:false по таймауту.
      detail = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() - startedAt + poll > timeout) {
      return { met: false, elapsedMs: Date.now() - startedAt, polls, detail };
    }
    await sleep(poll);
  }
}
