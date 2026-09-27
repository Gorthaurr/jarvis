// Сигнатура readPageInPage (исходник — read.js; исполняется в ИЗОЛИРОВАННОМ мире своим toString()).

export interface ReadMedia {
  currentTime: number;
  currentTimeLabel: string | null;
  duration: number | null;
  durationLabel: string | null;
  paused: boolean;
  /** Площадь плеера — для выбора крупнейшего между фреймами. */
  area: number;
}

export interface ReadResult {
  title: string;
  url: string;
  /** До 8000 символов: открытые окна первыми, затем main; при query — строки-совпадения с контекстом ±1. */
  text: string;
  headings: string[];
  /** query что-то выделил (false — общий дамп). */
  filtered: boolean;
  media?: ReadMedia;
}

export function readPageInPage(query?: string): ReadResult;
