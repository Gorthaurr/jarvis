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

/** Клик/наведение по цели. §14: подпись цели (и кнопок формы при expectChange) узнана guard без одобрения — commit_confirm. */
export function robustClickMain(params?: RobustClickParams): Promise<RobustClickDone | PageFail>;
