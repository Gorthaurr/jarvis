/**
 * W2 «GUI и гарды ввода» (пакет 0): контракты кадров, одобрения §14 и данных захвата/OCR.
 *
 * Отдельный модуль, чтобы `actions.ts` не рос: здесь — формы, которыми обмениваются сервер и клиент,
 * а поля в самих командах (`frame?`, `approval?`) ссылаются на эти типы.
 */

/**
 * Идентификатор кадра задачи (W2, решение №6): координаты модели ВСЕГДА относятся к кадру, который она видела.
 * Формат (П5): `<bootTag><f|z|o|s><n>` — метка загрузки клиента, вид кадра (полный/зум/OCR/выделение) и номер.
 * Неизвестный или вытесненный кадр → честная ошибка «кадр устарел, пересними», а не клик мимо.
 * `space:"screen"` (абсолютные DIP) остаётся в протоколе только для SDK и реплей-макросов §8.
 */
export type FrameId = string;

/**
 * Грант одобрения §14 (решение №3): владелец сказал «да» ровно на эту подпись в этом процессе.
 * Подпись и процесс считает ОДНА функция из `@jarvis/shared` (commit-signature) на обеих сторонах.
 * Грантов «по категории» нет; `count` — сколько раз можно (одно «да» на одну отправку).
 */
export interface CommitGrant {
  /** «key:enter», «click:отправить» — `commitSignature` из shared. */
  signature: string;
  /** Канонический процесс (`canonicalProcess`): «telegram», «1cv8»… */
  process: string;
  /** Окно, в котором владелец одобрил (если известно) — грант в другом окне того же процесса не действует. */
  hwnd?: number;
  /** Хост вкладки для категории web (браузер через GUI). */
  host?: string;
  count: number;
}

/**
 * Одобрение, приложенное к команде. СТАВИТ ТОЛЬКО СЕРВЕР (после «да» владельца); аргумент модели срезается
 * сборкой команды по allowlist полей схемы. Клиент читает его ЛИШЬ из области транспорта (ALS серверной команды):
 * у SDK-моста, реплея и локального UI области нет → fail-closed.
 */
export interface CommitApproval {
  grants: CommitGrant[];
  /** Абсолютное время (Date.now()), после которого одобрение не действует: сейчас + таймаут команды-носителя. */
  expiresAt: number;
}

/**
 * Клиентский рубеж не нашёл гранта на коммит: `ActionResult.error.code === "denied"`, а в `data.needsApproval` —
 * что именно спросить у владельца. Текст вопроса строит СЕРВЕР (категорию пересчитывает сам); строки с экрана
 * (`windowTitle`, `pendingText`) — недоверенные данные, сервер их чистит и капает.
 */
export interface NeedsApproval {
  category: string;
  process: string;
  hwnd?: number;
  windowTitle?: string;
  /** Человеко-описание действия: «Enter — отправка сообщения», «клик «Отправить»». */
  what: string;
  signature: string;
  /** Что набрано перед коммитом (буфер ввода, ≤ 200 символов) — владелец видит, ЧТО уйдёт. */
  pendingText?: string;
}

/** Данные `screen.capture` (П5 наполняет frameId; `zoomOf` — кадр, из которого сделан зум). */
export interface CaptureData {
  image: string;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  frameId: FrameId;
  zoomOf?: FrameId;
}

/** Строка OCR: bbox в системе координат кадра `OcrData.frame` (или o-кадра `frameId`). */
export interface OcrLineData {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Данные `screen.ocr`. `mapping` нужен SDK (перевод координат строк в экранные DIP). */
export interface OcrData {
  text: string;
  lines: OcrLineData[];
  width: number;
  height: number;
  frameId: FrameId;
  /** Кадр задачи, в системе которого отданы строки (если сервер его передал). */
  frame?: FrameId;
  mapping?: { boundsX: number; boundsY: number; scale: number };
}

/** Результат `app.launch` (G-20): окно найдено — {hwnd,title}; не дождались — `windowSeen:false`. */
export interface AppLaunchWindow {
  window?: { hwnd: number; title: string };
  windowSeen?: boolean;
}
