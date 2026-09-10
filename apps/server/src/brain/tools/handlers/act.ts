/**
 * W4 «Руки» (2026-09-10): результат примитива `act` (ActionCommand gui.act) → ToolResult.
 *
 * Зачем отдельный хендлер: у generic-пути один признак сверки — fused-наблюдение (`observed = !weak`). У act
 * ИСХОДОВ ТРИ, и они важнее наблюдения:
 *  - verified:"met" — признак verify наступил → сверка состоялась (observed), даже если дельта окна слабая
 *    (признак может жить вне активного окна — новое окно, исчезнувший диалог);
 *  - verified:"failed" — действие УШЛО, признак не наступил → НЕ observed и `uncertain` (журнал чекпойнта: «исход
 *    неизвестен — сверь перед повтором», а не «ОШИБКА = не сделано», после которой «доделай» кликает второй раз);
 *  - verified:"unchecked" — признак не задан / сенсор не ответил → судим по дельте наблюдения, как у input_click.
 * Частичное исполнение (клик в поле ушёл, печать упала) приезжает ошибкой с `stepActionInjected` → тоже `uncertain`.
 * Ошибки поиска/фокуса/вуали/канала — прежними путями dispatch (null отсюда).
 */
import type { ActionResult } from "@jarvis/protocol";
import type { ToolResult } from "../dispatch.js";
import { type PostActionObservation, applyVeil, capResultBody, err, formatObservationBlock, ok, stripVeilFields } from "../dispatch-util.js";

interface ActData {
  found?: { via?: string; name?: string; role?: string; handle?: string; note?: string };
  focused?: string;
  did?: string;
  verified?: "met" | "failed" | "unchecked";
  detail?: string;
  observation?: PostActionObservation;
  screenX?: number;
  screenY?: number;
  physical?: boolean;
}

/** Строка вердикта — модель читает её ПЕРВОЙ, до наблюдения. */
export function verdictLine(verified: ActData["verified"], detail: string | undefined): string {
  const d = detail ? ` ${detail}` : "";
  switch (verified) {
    case "met":
      return `✅ ИСХОД ПОДТВЕРЖДЁН признаком verify.${d}`;
    case "failed":
      return `⚠️ ДЕЙСТВИЕ УШЛО, признак verify НЕ наступил.${d} НЕ повторяй вслепую (второй клик/Enter = дубль): сверь состояние (ui_snapshot / screen_read_text / screen_capture) и действуй иначе.`;
    default:
      return `ℹ️ Исход признаком НЕ сверен.${d} Суди по дельте наблюдения ниже; её нет или она слабая → сверь глазами перед «готово».`;
  }
}

/** Успех/частичный провал act → ToolResult; прочие ошибки (поиск, фокус, вуаль, канал) → null (generic-путь). */
export function actResult(result: ActionResult): ToolResult | null {
  if (!result.ok) {
    if (result.error?.code !== "runtime" || result.stepActionInjected !== true) return null;
    const out = err(`act: ${result.error.message} ИСХОД НЕИЗВЕСТЕН — не повторяй вслепую, сверь состояние.`);
    out.uncertain = true;
    return out;
  }
  const raw = (result.data && typeof result.data === "object" ? result.data : {}) as ActData & Record<string, unknown>;
  const { observation, ...rest } = raw;
  const head = JSON.stringify(stripVeilFields(rest as Record<string, unknown>));
  const obs = observation && typeof observation.text === "string" ? `\n${formatObservationBlock(observation, "Наблюдение сразу после действия")}` : "";
  const out = ok(capResultBody(`${head}\n${verdictLine(raw.verified, raw.detail)}${obs}`));
  out.data = rest;
  const obsStrong = Boolean(observation) && observation?.weak !== true;
  out.observed = raw.verified === "met" || (raw.verified === "unchecked" && obsStrong);
  if (raw.verified === "failed") out.uncertain = true;
  applyVeil(out, result.data);
  return out;
}
