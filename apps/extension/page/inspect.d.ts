// Сигнатура inspectPageInPage (исходник — inspect.js; исполняется в ИЗОЛИРОВАННОМ мире своим toString()).

export interface InspectElementState {
  /** Поле: значение (секретное — «•••»), список — выбранный текст. */
  value?: string;
  empty?: true;
  checked?: boolean | string;
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  disabled?: true;
  /** Список: до 25 вариантов по тексту. */
  options?: string[];
}

export interface InspectElement {
  /** Локальный ref реестра: e<gen>_<n>; жив, пока жив элемент и документ. */
  ref: string;
  tag: string;
  /** Только у input. */
  type?: string;
  role: string;
  name: string | null;
  text?: string;
  label?: string;
  /** §0: пароль / одноразовый код / карта — значение не отдаётся. */
  secret?: true;
  state: InspectElementState;
  /** Устойчивый селектор-фолбэк, « host >>> inner » — сквозь shadow DOM. */
  selector: string;
  /** Селектор бьёт не только в этот узел. */
  ambiguous?: true;
  href?: string;
  /** Только при query (find) — ранг для слияния фреймов. */
  score?: number;
}

export interface InspectSnapshot {
  url: string;
  title: string;
  count: number;
  truncated: boolean;
  /** Метка документа реестра ref. */
  gen: number;
  elements: InspectElement[];
}

/** Снимок интерактивных элементов; query — find (ранг, до cap лучших), без query — по порядку документа до cap. */
export function inspectPageInPage(query?: string, cap?: number): InspectSnapshot;
