/**
 * W4 «Руки» (2026-09-10): СВЕРКА исхода примитива gui.act — два независимых источника.
 *
 *  1. Fused-наблюдение (observe.ts): дельта структуры окна ДО/ПОСЛЕ («+ появилось / − исчезло») — то же
 *     наблюдение, что у input_click/ui_invoke; на UIA-слепом окне — сравнение OCR-области вокруг точки.
 *  2. Признак `verify` от модели — короткое клиентское ожидание (wait.for): текст появился/исчез, элемент
 *     есть/нет, заголовок окна. Ждём не дольше остатка бюджета act.
 *
 * ТРИ исхода, не два: «met» (признак наступил — исход подтверждён), «failed» (действие ушло, признак за
 * timeoutMs не наступил — НЕ «не сделано»: повтор = дубль) и «unchecked» (признака нет или сенсор не смог
 * ответить — `unknown` от wait.for: «не смог проверить» ≠ «не наступило», урок watch-предикатов).
 */
import type { ActVerify, WaitCondition } from "@jarvis/protocol";
import { type Observation, type UiFingerprint, observeAfterAction } from "./observe.js";
import { waitFor } from "./sensors-cheap.js";

export type ActVerified = "met" | "failed" | "unchecked";

export interface ActVerdict {
  verified: ActVerified;
  /** Почему такой вердикт — по-русски, едет модели. */
  detail: string;
  observation?: Observation;
}

/** Границы ожидания признака: короткое (дефолт 4 с), не дольше 15 с и не дольше остатка бюджета act. */
export const VERIFY_DEFAULT_MS = 4_000;
export const VERIFY_MAX_MS = 15_000;
const VERIFY_MIN_MS = 500;
const VERIFY_POLL_MS = 700;

/** Условие wait.for из verify. Нет ни одного признака → null (сверять нечем). ЧИСТАЯ функция (экспорт для теста). */
export function verifyCondition(v: ActVerify): WaitCondition | null {
  const gone = v.gone === true;
  if (v.text?.trim()) return { kind: "text", text: v.text.trim(), monitor: "active", gone };
  if (v.element?.role?.trim()) {
    return { kind: "ui", role: v.element.role.trim(), name: v.element.name?.trim() || undefined, nameMode: "substring", gone };
  }
  if (v.title?.trim()) return { kind: "window", titleContains: v.title.trim(), gone };
  return null;
}

/** Как назвать признак в отчёте. */
function describe(v: ActVerify): string {
  const what = v.text ? `текст «${v.text}»` : v.element ? `элемент ${v.element.role}${v.element.name ? ` «${v.element.name}»` : ""}` : `окно «${v.title ?? ""}»`;
  return v.gone ? `исчезновение: ${what}` : what;
}

/**
 * Ревью 2026-09-24 (H-V1): признак, видимый ДО действия, исход не доказывает («Настройки» на вкладке «Настройки»,
 * кнопка «Принять», которая и была). Проверяем его один раз до действия: наступил уже → итоговое «met» не
 * засчитывается (вердикт unchecked с объяснением). Сенсор не смог ответить → считаем, что не было (не мешаем сверке).
 */
export async function precheckVerify(verify: ActVerify | undefined, deadline: number): Promise<boolean> {
  const cond = verify ? verifyCondition(verify) : null;
  if (!cond || deadline - Date.now() < VERIFY_MIN_MS * 4) return false;
  const r = await waitFor(cond, VERIFY_MIN_MS, VERIFY_POLL_MS);
  return r.met === true && r.unknown !== true;
}

/**
 * Сверить исход: наблюдение-дельта всегда; признак — если задан. `deadline` — абсолютное время конца бюджета
 * act: ожидание признака клампится к остатку, чтобы серверный потолок не превратил успех в таймаут.
 */
export async function verifyOutcome(
  verify: ActVerify | undefined,
  ctx: { before?: UiFingerprint; clickPoint?: { x: number; y: number }; deadline: number; preMet?: boolean },
): Promise<ActVerdict> {
  const observation = await observeAfterAction({ settleMs: 350, clickPoint: ctx.clickPoint, before: ctx.before });
  const cond = verify ? verifyCondition(verify) : null;
  if (!cond) {
    const detail = !verify
      ? observation && observation.weak !== true
        ? "признак verify не задан — суди по дельте наблюдения ниже"
        : "признак verify не задан, наблюдение слабое или недоступно — исход НЕ подтверждён, сверь глазами"
      : "verify без признака (нужен text / element / title) — исход не сверен";
    return { verified: "unchecked", detail, observation };
  }
  const want = Math.min(VERIFY_MAX_MS, Math.max(VERIFY_MIN_MS, verify?.timeoutMs ?? VERIFY_DEFAULT_MS));
  const left = ctx.deadline - Date.now();
  if (left < VERIFY_MIN_MS) {
    return { verified: "unchecked", detail: `на ожидание признака (${describe(verify!)}) не осталось бюджета — исход не сверен`, observation };
  }
  const timeoutMs = Math.min(want, left);
  const r = await waitFor(cond, timeoutMs, VERIFY_POLL_MS);
  const label = describe(verify!);
  if (r.met && ctx.preMet) {
    return {
      verified: "unchecked",
      detail: `признак (${label}) был виден ещё ДО действия — исход он не доказывает; выбери меняющийся признак (новый текст или gone:true)`,
      observation,
    };
  }
  if (r.met) return { verified: "met", detail: `признак наступил (${label}) за ${r.elapsedMs} мс: ${r.detail}`, observation };
  if (r.unknown) return { verified: "unchecked", detail: `сенсор не смог проверить признак (${label}): ${r.detail}`, observation };
  return {
    verified: "failed",
    detail: `признак НЕ наступил за ${timeoutMs} мс (${label})${timeoutMs < want ? " — ожидание урезано бюджетом" : ""}: ${r.detail}`,
    observation,
  };
}
