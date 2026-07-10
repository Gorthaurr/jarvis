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
}

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
 * Снять дешёвое наблюдение после действия. clickPoint — экранные DIP-координаты действия
 * (для OCR-региона); settleMs — пауза стабилизации (клик 350мс, печать 150мс).
 * undefined = наблюдение недоступно (вызывающий возвращает результат без него).
 */
export async function observeAfterAction(opts?: {
  settleMs?: number;
  clickPoint?: { x: number; y: number };
}): Promise<Observation | undefined> {
  if (!enabled() || !sidecar().ready) return undefined;
  try {
    await sleep(opts?.settleMs ?? DEFAULT_SETTLE_MS);

    // Ступень 1: a11y-выжимка активного окна (дёшево; для обычных приложений — достаточно).
    let a11yText = "";
    try {
      const data = (await sidecar().request("read.window", { maxChars: TEXT_CAP + 200 }, 4_000)) as { text?: string };
      a11yText = String(data?.text ?? "").trim();
    } catch (e) {
      log.debug(`observe: a11y-выжимка не удалась (${e instanceof Error ? e.message : String(e)})`);
    }
    if (a11yText.length >= MIN_A11Y_CHARS) {
      return { via: "a11y", window: await foregroundTitle(), text: clip(a11yText) };
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
    return {
      via: "ocr",
      window: await foregroundTitle(),
      text: text ? clip(text) : "(распознаваемого текста в области действия не видно)",
    };
  } catch (e) {
    log.debug(`observe: наблюдение недоступно (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}
