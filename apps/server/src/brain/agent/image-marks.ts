/**
 * Маркер image-блока «страница документа» (§3.9 зрение на файл) — ЕДИНОЕ место, где первая строка
 * текстового блока рядом с картинкой и СОБИРАЕТСЯ (handlers/file-view.ts), и РАЗБИРАЕТСЯ
 * (agent/prune-images.ts). Свёртка старых картинок по этому маркеру отличает документ от скриншота:
 * скриншот устаревает (экран живёт), страница файла — нет. Разойдись формат сборки и разбора —
 * документу снова подписывали бы «скриншот устарел, сними свежий screen_capture» (ложь).
 */
export const FILE_VIEW_MARK = "[file_view]";
/** Маркер скриншота — первая строка текста lookAtScreen (dispatch.ts берёт ОТСЮДА, не своей копией). */
export const SCREEN_CAPTURE_MARK = "Снимок рабочего экрана";

export type ImageClass = "doc" | "screenshot" | "other";

/**
 * Класс image-блоков одного tool_result по его текстовым блокам: документ (file_view), скриншот
 * (screen_capture) или прочее (картинка MCP-инструмента). ПОЗИТИВНАЯ классификация: «не документ» ≠
 * «скриншот» — картинке из MCP нельзя подписывать «сними свежий screen_capture» (ревью 2026-09-01).
 */
export function classifyImageBlocks(blocks: ReadonlyArray<{ type: string; text?: string }>): ImageClass {
  let cls: ImageClass = "other";
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue;
    if (isFileViewMark(b.text)) return "doc";
    if (b.text.startsWith(SCREEN_CAPTURE_MARK)) cls = "screenshot";
  }
  return cls;
}

export interface FileViewMark {
  path: string;
  /** Страница и их число — только у многостраничных (PDF); у картинки отсутствуют. */
  page?: number;
  pageCount?: number;
}

/** Первая строка текстового блока file_view: маркер, путь в «», опц. «стр. N/M», затем детали. */
export function formatFileViewMark(m: FileViewMark & { detail: string }): string {
  const pages = m.page !== undefined && m.pageCount !== undefined ? ` стр. ${m.page}/${m.pageCount}` : "";
  return `${FILE_VIEW_MARK} «${m.path}»${pages} — ${m.detail}`;
}

/** Начинается ли текст с маркера документа (быстрая классификация без разбора). */
export function isFileViewMark(text: string): boolean {
  return text.startsWith(FILE_VIEW_MARK);
}

const MARK_RE = new RegExp(`^${FILE_VIEW_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} «(.+)»(?: стр\\. (\\d+)/(\\d+))? — `, "u");

/** Разобрать первую строку блока: путь/страница для заглушки свёртки. Не маркер → null. */
export function parseFileViewMark(text: string): FileViewMark | null {
  if (!isFileViewMark(text)) return null;
  const line = text.split("\n")[0] ?? "";
  const m = MARK_RE.exec(line);
  if (!m) return null;
  const out: FileViewMark = { path: m[1]! };
  if (m[2] !== undefined && m[3] !== undefined) {
    out.page = Number(m[2]);
    out.pageCount = Number(m[3]);
  }
  return out;
}
