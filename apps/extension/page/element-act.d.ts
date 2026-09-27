// Сигнатура elementActIsolated (исходник — element-act.js; исполняется в ИЗОЛИРОВАННОМ мире своим toString()).
import type { PageFail, PageGuardParams } from "./types.js";

export type ElementIntent = "type" | "set" | "select" | "key" | "enter" | "submit" | "scroll_to" | "scroll" | "seek";

export interface ElementActParams extends PageGuardParams {
  /** Цель: CSS-селектор, « host >>> inner » — сквозь shadow DOM. Не найден — not_found (в фокус не печатает). */
  selector?: string;
  /** Цель по подписи (скоринг: точно / целым словом / префикс; короткое — не подстрокой). */
  label?: string;
  /** type — содержимое; у прочих интентов — подпись цели. */
  text?: string;
  value?: string | number | boolean;
  option?: string | number;
  checked?: boolean | "true" | "false" | "on" | "off" | 0 | 1;
  /** key: одна клавиша плюс модификаторы (Enter, Ctrl+Enter, Tab, Escape…). */
  combo?: string;
  key?: string;
  /** type: после ввода нажать Enter (только строгое true); submit — ещё и отправить форму. */
  enter?: boolean;
  submit?: boolean;
  /** seek: абсолютная позиция / сдвиг в секундах; scroll: шаг в px. */
  to?: number;
  seconds?: number;
  dy?: number;
}

export interface ElementActDone {
  /** select может вернуть ok:false без code — вариант не выбрался (сверка по selectedOptions). */
  ok: boolean;
  code?: undefined;
  value?: string;
  submitted?: boolean;
  changed?: boolean;
  checked?: boolean;
  sent?: string;
  note?: string;
  inViewport?: boolean;
  currentTime?: number;
}

/**
 * Действие над элементом. localRef — локальный ref снимка (e<gen>_<n>) или null; без цели type/key/enter/submit идут в
 * фокус страницы (type без фокуса — в первое видимое поле). §0: секретное поле — secret_field; §14: guard — commit_confirm.
 */
export function elementActIsolated(localRef: string | null, intent: ElementIntent, params?: ElementActParams): Promise<ElementActDone | PageFail>;
