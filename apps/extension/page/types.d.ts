// Общие типы ответов page-функций (page/*.js исполняются В СТРАНИЦЕ своим toString(); здесь только описание формы).

/** Коды отказа: строгие — цель не найдена / секретное поле / коммит без одобрения ≠ «сделал». */
export type PageFailCode = "ref_stale" | "not_found" | "secret_field" | "commit_confirm" | "invalid_combo" | "no_effect" | "capture_failed";

/** Отказ страницы. code отсутствует у «прочих» провалов (элемент не поле, вариант не найден, исключение). */
export interface PageFail {
  ok: false;
  code?: PageFailCode;
  error: string;
  /** commit_confirm: подпись, узнанная гардом §14, без обрезки — её видит владелец в вопросе. */
  label?: string;
}

/** Параметры §14-гарда на странице: guard ставит ТОЛЬКО сервер (pageGuardFor), одобрение — только после «да». */
export interface PageGuardParams {
  /** Исходник регэкспа глаголов коммита (флаги iu); битый — throw, действия нет. */
  guard?: string;
  guardApproved?: boolean;
  /** Одобренная подпись: пропускает, только если сложенная часть подписи цели ей РАВНА (не подстрока). */
  approvedLabel?: string;
  /** Одобренный ref: пропускает, только если совпал с P.ref и цель адресована по ref. */
  approvedRef?: string;
  ref?: string;
}
