// Сигнатура probeFindInPage (исходник — probe.js; исполняется в каждом фрейме своим toString()).

export interface ProbeSpec {
  selector?: string;
  text?: string;
  media?: boolean;
}

export interface ProbeResult {
  found: boolean;
  /** Сила матча: текст ≥ 80 (целое слово или точно), медиа 100, селектор 120. */
  score?: number;
  url: string;
  /** Ответ top-фрейма: там не ищем. */
  top?: true;
  error?: string;
}

export function probeFindInPage(spec?: ProbeSpec): ProbeResult;
