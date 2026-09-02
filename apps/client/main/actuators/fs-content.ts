/**
 * Содержимое файла как ТЕКСТ — честно (§6; CAPABILITY_GAPS 2026-09-01 §3.9(б)).
 *
 * До этого `fs_read` отдавал PDF/PNG/docx как utf8-мусор БЕЗ ошибки — модель «читала» документ и
 * делала выводы из �-каши (ложный успех чтения). Здесь: (1) БИНАРНИК распознаётся по содержимому
 * первых 8 КБ (NUL-байт / доля управляющих байтов) и по сигнатурам известных форматов — с КЛАССОМ
 * файла и подсказкой, каким каналом его читать; (2) текст в UTF-16 с BOM — это ТЕКСТ с NUL-байтами,
 * а не бинарник: декодируется честно (utf16le/be); BOM UTF-8 срезается.
 *
 * ЧИСТЫЙ модуль (без ФС) — тестируется на буферах. Сигнатуры из чистого ASCII («GIF8», «RIFF», «MZ»…)
 * считаются СЛАБЫМИ: текстовый файл может так начинаться, поэтому они лишь ПОДПИСЫВАЮТ тип, когда
 * эвристика содержимого уже сказала «бинарник»; решают сами только сигнатуры с не-текстовыми байтами.
 */

const SNIFF_BYTES = 8 * 1024;
/** Доля управляющих байтов (кроме \t\n\v\f\r и ESC), выше которой содержимое считаем бинарным. */
const CONTROL_RATIO_BINARY = 0.1;

export type TextEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "cp1251";
/** Формат по сигнатуре — ЕДИНАЯ таблица на клиент: file-sniff.ts (file_view) берёт её отсюда, а не держит свою. */
export type SniffFormat = "png" | "jpeg" | "gif" | "webp" | "pdf" | "zip" | "bmp";
export type BinaryFamily = "pdf" | "image" | "word" | "excel" | "ppt" | "archive" | "media" | "exe" | "other";
export interface BinaryKind {
  type: string;
  family: BinaryFamily;
  /** Картинку принимает file_view (png/jpeg/gif/webp); иначе подсказка ведёт в конвертацию, а не в инструмент, который откажет. */
  viewable?: boolean;
  /** Формат для file_view (по сигнатуре). */
  format?: SniffFormat;
}

export type ContentSniff =
  | { kind: "empty" }
  | { kind: "text"; encoding: TextEncoding; bomBytes: number }
  | { kind: "binary"; type: string; family: BinaryFamily; hint: string; format?: SniffFormat };

/** Куда идти вместо fs_read — по КЛАССУ файла (попадает в текст ошибки как есть). */
const HINTS: Record<BinaryFamily, string> = {
  pdf: "Страницу как картинку — file_view; текст — рецепт pdftotext (app_channels «PDF»).",
  image: "Посмотреть картинку — file_view.",
  word: "Открыть/прочитать — office_word.",
  excel: "Открыть/прочитать — office_excel.",
  ppt: "Прочитать — python-pptx через code_run (или officecli, см. app_channels).",
  archive: "Распаковать через code_run, затем читать нужные файлы.",
  media: "Медиа текстом не читается; метаданные — ffprobe через code_run.",
  exe: "Исполняемый файл — читать нечего; версия/подпись — через code_run.",
  other: "Работай через code_run/специализированный инструмент, а не fs_read.",
};

/** Форматы, которые file_view реально показывает (сигнатуры png/jpeg/gif/webp). bmp/ico/tiff он честно отвергает —
 *  посылать туда значило бы ПИНГ-ПОНГ между двумя инструментами (ревью 2026-09-01). */
const VIEWABLE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const HINT_IMAGE_CONVERT = "Картинка этого формата в file_view не проходит — сконвертируй в PNG через code_run (Pillow), затем file_view.";

const FAMILY_BY_EXT: Record<string, BinaryFamily> = {
  ".pdf": "pdf",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".bmp": "image", ".ico": "image", ".tif": "image", ".tiff": "image",
  ".docx": "word", ".doc": "word",
  ".xlsx": "excel", ".xls": "excel",
  ".pptx": "ppt", ".ppt": "ppt",
  ".zip": "archive", ".7z": "archive", ".rar": "archive", ".gz": "archive", ".tar": "archive",
  ".mp3": "media", ".mp4": "media", ".wav": "media", ".avi": "media", ".mkv": "media", ".mov": "media", ".ogg": "media", ".flac": "media",
  ".exe": "exe", ".dll": "exe",
};
const OFFICE_ZIP: Record<string, BinaryKind> = {
  ".docx": { type: "документ Word .docx (zip-контейнер)", family: "word" },
  ".xlsx": { type: "книга Excel .xlsx (zip-контейнер)", family: "excel" },
  ".pptx": { type: "презентация PowerPoint .pptx (zip-контейнер)", family: "ppt" },
};
const OFFICE_OLE: Record<string, BinaryKind> = {
  ".doc": { type: "документ Word .doc (старый формат)", family: "word" },
  ".xls": { type: "книга Excel .xls (старый формат)", family: "excel" },
  ".ppt": { type: "презентация PowerPoint .ppt (старый формат)", family: "ppt" },
};

interface Signature { magic: number[]; offset?: number; weak?: boolean; label: (ext: string, head: Buffer) => BinaryKind }
const ascii = (s: string): number[] => [...Buffer.from(s, "latin1")];
const fixed = (type: string, family: BinaryFamily, viewable?: boolean, format?: SniffFormat) => (): BinaryKind => ({
  type,
  family,
  ...(viewable ? { viewable } : {}),
  ...(format ? { format } : {}),
});
const riffLabel = (_e: string, head: Buffer): BinaryKind => {
  const form = head.subarray(8, 12).toString("latin1");
  if (form === "WEBP") return { type: "WEBP-изображение", family: "image", viewable: true, format: "webp" };
  return { type: form === "WAVE" ? "аудио WAV" : form === "AVI " ? "видео AVI" : "RIFF-медиа", family: "media" };
};

const SIGNATURES: Signature[] = [
  { magic: ascii("%PDF"), label: fixed("PDF-документ", "pdf", undefined, "pdf") },
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label: fixed("PNG-изображение", "image", true, "png") },
  { magic: [0xff, 0xd8, 0xff], label: fixed("JPEG-изображение", "image", true, "jpeg") },
  { magic: [0x50, 0x4b, 0x03, 0x04], label: (e) => ({ ...(OFFICE_ZIP[e] ?? { type: `ZIP-архив${e ? ` (${e})` : ""}`, family: "archive" as const }), format: "zip" as const }) },
  { magic: [0x50, 0x4b, 0x05, 0x06], label: (e) => OFFICE_ZIP[e] ?? { type: "ZIP-архив (пустой)", family: "archive" } },
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], label: (e) => OFFICE_OLE[e] ?? { type: "OLE-контейнер (старый формат Office)", family: "other" } },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: fixed("архив 7z", "archive") },
  { magic: [0x1f, 0x8b], label: fixed("архив gzip", "archive") },
  { magic: [0x7f, 0x45, 0x4c, 0x46], label: fixed("исполняемый файл ELF", "exe") },
  { magic: ascii("SQLite format 3"), label: fixed("база данных SQLite", "other") },
  { magic: ascii("GIF8"), weak: true, label: fixed("GIF-изображение", "image", true, "gif") },
  // BMP: «BM» — два ASCII-байта, решает только при корроборации бинарностью («BMW-план.txt» — текст).
  { magic: ascii("BM"), weak: true, label: fixed("BMP-изображение", "image", undefined, "bmp") },
  { magic: ascii("RIFF"), weak: true, label: riffLabel },
  { magic: ascii("Rar!"), weak: true, label: fixed("архив RAR", "archive") },
  { magic: ascii("ftyp"), offset: 4, weak: true, label: fixed("видео/аудио MP4/MOV", "media") },
  { magic: ascii("ID3"), weak: true, label: fixed("аудио MP3", "media") },
  { magic: ascii("OggS"), weak: true, label: fixed("аудио/видео OGG", "media") },
  { magic: ascii("fLaC"), weak: true, label: fixed("аудио FLAC", "media") },
  { magic: ascii("MZ"), weak: true, label: fixed("исполняемый файл EXE/DLL", "exe") },
];

function matchesAt(head: Buffer, magic: number[], offset: number): boolean {
  if (head.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (head[offset + i] !== magic[i]) return false;
  return true;
}

/** Эвристика содержимого: NUL-байт → бинарник; иначе — доля управляющих байтов выше порога.
 *  ЕДИНСТВЕННАЯ на клиенте (file-sniff.ts берёт её же — две эвристики давали пинг-понг fs_read↔file_view). */
export function looksBinary(head: Buffer): boolean {
  let control = 0;
  for (let i = 0; i < head.length; i += 1) {
    const c = head[i]!;
    if (c === 0) return true;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0b && c !== 0x0c && c !== 0x0d && c !== 0x1b) || c === 0x7f) control += 1;
  }
  return control / head.length > CONTROL_RATIO_BINARY;
}

function byExtension(ext: string, why = "формат по содержимому не распознан"): BinaryKind {
  const family = FAMILY_BY_EXT[ext] ?? "other";
  return { type: ext ? `расширение ${ext}, ${why}` : "формат не распознан", family, ...(family === "image" && VIEWABLE_EXT.has(ext) ? { viewable: true } : {}) };
}

/**
 * UTF-16 с BOM — текст ТОЛЬКО если декодированные код-юниты похожи на текст: NUL-символ или доля управляющих
 * выше порога = бинарник, у которого первые два байта случайно FF FE (ревью 2026-09-01: BOM решал безусловно,
 * и бинарник снова уезжал модели мусором «utf16le» без ошибки).
 */
function utf16LooksLikeText(buf: Buffer, be: boolean): boolean {
  const body = buf.subarray(2, 2 + SNIFF_BYTES);
  const even = body.subarray(0, body.length - (body.length % 2));
  const text = be ? Buffer.from(even).swap16().toString("utf16le") : even.toString("utf16le");
  if (text.length === 0) return true;
  let control = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0) return false;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0b && c !== 0x0c && c !== 0x0d && c !== 0x1b) || c === 0x7f) control += 1;
  }
  return control / text.length <= CONTROL_RATIO_BINARY;
}

/** Что перед нами: пусто / текст (с кодировкой и длиной BOM) / бинарник (с классом и подсказкой). `ext` — с точкой. */
export function sniffContent(buf: Buffer, ext: string): ContentSniff {
  if (buf.length === 0) return { kind: "empty" };
  const e0 = ext.toLowerCase();
  if (matchesAt(buf, [0xff, 0xfe], 0)) {
    return utf16LooksLikeText(buf, false) ? { kind: "text", encoding: "utf16le", bomBytes: 2 } : binary(byExtension(e0, "начинается как UTF-16 (FF FE), но содержимое не текст"));
  }
  if (matchesAt(buf, [0xfe, 0xff], 0)) {
    return utf16LooksLikeText(buf, true) ? { kind: "text", encoding: "utf16be", bomBytes: 2 } : binary(byExtension(e0, "начинается как UTF-16 (FE FF), но содержимое не текст"));
  }
  if (matchesAt(buf, [0xef, 0xbb, 0xbf], 0)) return { kind: "text", encoding: "utf8-bom", bomBytes: 3 };
  const head = buf.subarray(0, SNIFF_BYTES);
  const e = ext.toLowerCase();
  const sig = SIGNATURES.find((s) => matchesAt(head, s.magic, s.offset ?? 0));
  if (sig && !sig.weak) return binary(sig.label(e, head));
  if (!looksBinary(head)) return { kind: "text", encoding: "utf8", bomBytes: 0 };
  return binary(sig ? sig.label(e, head) : byExtension(e));
}

function binary(k: BinaryKind): ContentSniff {
  const hint = k.family === "image" && !k.viewable ? HINT_IMAGE_CONVERT : HINTS[k.family];
  return { kind: "binary", type: k.type, family: k.family, hint, ...(k.format ? { format: k.format } : {}) };
}

/**
 * Декодировать байты [bom, limitBytes) как текст. UTF-16 выравнивается до чётной длины: LE-декодер Node
 * хвостовой байт отбрасывает сам, а BE идёт через `swap16` на КОПИИ, и на нечётной длине он БРОСАЕТ.
 */
export function decodeText(buf: Buffer, sniff: Extract<ContentSniff, { kind: "text" }>, limitBytes: number): string {
  return decodeTextDetailed(buf, sniff, limitBytes).text;
}

/**
 * То же, но с ФАКТИЧЕСКОЙ кодировкой: байты, не легшие в UTF-8, пробуем как cp1251 (Блокнот/старые русские
 * программы — норма у владельца). Декодер cp1251 тотальный (любой байт валиден), поэтому принимаем результат
 * ТОЛЬКО если вышел кириллический текст — иначе честно остаёмся на UTF-8 с «�» (вызывающий поставит note).
 */
export function decodeTextDetailed(buf: Buffer, sniff: Extract<ContentSniff, { kind: "text" }>, limitBytes: number): { text: string; encoding: TextEncoding } {
  const start = sniff.bomBytes;
  let end = Math.min(buf.length, Math.max(start, limitBytes));
  if (sniff.encoding === "utf8" || sniff.encoding === "utf8-bom") {
    const utf8 = buf.subarray(start, end).toString("utf8");
    // «�» в хвосте усечённого UTF-8 — разрезанный multibyte-символ, не чужая кодировка: хвост не считаем.
    const probe = end < buf.length ? utf8.replace(/�+$/u, "") : utf8;
    if (probe.includes("�")) {
      const cp = new TextDecoder("windows-1251").decode(buf.subarray(start, end));
      if (looksLikeCp1251Text(cp)) return { text: cp, encoding: "cp1251" };
    }
    return { text: utf8, encoding: sniff.encoding };
  }
  end -= (end - start) % 2;
  const body = buf.subarray(start, end);
  const text = sniff.encoding === "utf16le" ? body.toString("utf16le") : Buffer.from(body).swap16().toString("utf16le");
  // Усечение по maxBytes могло разрезать суррогатную пару — одинокий high-surrogate в JSON запроса невалиден.
  const last = text.charCodeAt(text.length - 1);
  return { text: end < buf.length && last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text, encoding: sniff.encoding };
}

/** cp1251-кандидат принимается, если среди букв ≥50% кириллицы и нет управляющих символов (koi8-r/cp866 дадут другую картину). */
function looksLikeCp1251Text(t: string): boolean {
  let letters = 0;
  let cyr = 0;
  for (let i = 0; i < t.length; i += 1) {
    const c = t.charCodeAt(i);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) letters += 1;
    else if ((c >= 0x410 && c <= 0x44f) || c === 0x401 || c === 0x451) { letters += 1; cyr += 1; }
    else if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false;
  }
  return letters > 0 && cyr / letters >= 0.5;
}

/** Текст файла для поиска по содержимому: бинарник → null (мусор не сканируем), иначе — декодированный текст. */
export function textForSearch(buf: Buffer, ext: string): string | null {
  return textForSearchDetailed(buf, ext)?.text ?? null;
}

/** То же с фактической кодировкой (search считает cp1251-файлы отдельно — прочитаны по эвристике). */
export function textForSearchDetailed(buf: Buffer, ext: string): { text: string; encoding: TextEncoding } | null {
  const s = sniffContent(buf, ext);
  if (s.kind === "binary") return null;
  return s.kind === "empty" ? { text: "", encoding: "utf8" } : decodeTextDetailed(buf, s, buf.length);
}
