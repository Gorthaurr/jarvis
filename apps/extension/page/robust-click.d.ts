// Сигнатура robustClickMain (исходник — robust-click.js; исполняется в MAIN-мире своим toString()).
import type { PageFail, PageGuardParams } from "./types.js";

export interface RobustClickParams extends PageGuardParams {
  /** Цель по ref: элемент заранее помечен stampRefIsolated(localRef, nonce); ровно один матч, иначе ref_stale. */
  nonce?: string;
  /** Цель: CSS-селектор (« host >>> inner » — сквозь shadow DOM). */
  selector?: string;
  /** Цель по тексту: скоринг (точно / целым словом / префикс), короткий запрос — только точно или словом. */
  text?: string;
  /** hover — навести указатель без клика (гард не нужен). */
  action?: "hover";
  /** Встряхивание: pointer → React-onClick → Enter, пока страница не изменится; иначе no_effect. */
  expectChange?: boolean;
}

export interface RobustClickDone {
  ok: true;
  method: "pointer" | "react" | "enter" | "hover";
  /** Страница отреагировала (мутации вне шума, смена url/диалогов/состояния цели). */
  changed: boolean;
  /** false — синтетический клик до цели не дошёл (гейт в capture-фазе), React-пропа нет. */
  reached?: false;
  /** SPA-переход: новый location.href. */
  navigated?: string;
}

/**
 * Документ ушёл (pagehide) посреди ожидания после жеста: жёсткий переход, в bfcache страница ЗАМОРОЖЕНА и иначе не ответила
 * бы вовсе. Маркер, не исход: расширение по нему судит вкладку/фрейм (modules/page-left.js); прочим он честен и сам по себе.
 */
export interface RobustClickLeft {
  ok: true;
  pageLeft: true;
  navigated: true;
  /** Переход вероятен, исход самого клика НЕ подтверждён — verify-долг не снимается. */
  uncertain: true;
  note: string;
}

/** Клик/наведение по цели. §14: подпись цели (и кнопок формы при expectChange) узнана guard без одобрения — commit_confirm. */
export function robustClickMain(params?: RobustClickParams): Promise<RobustClickDone | RobustClickLeft | PageFail>;
