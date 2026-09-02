/**
 * Определение типа файла ПО СИГНАТУРЕ (magic bytes), не по расширению (§3.9 зрение на файл).
 *
 * Расширение — заявление, а не факт: «скрин.png», сохранённый браузером как JPEG, или «отчёт.pdf»,
 * который на деле HTML-страница логина, встречаются постоянно. Декодер, поверивший расширению,
 * либо упадёт с невнятной ошибкой, либо (хуже) отдаст мусор как картинку. Чистые функции без IO.
 *
 * Ревью 2026-09-01: таблица сигнатур и эвристика «текст или бинарник» ОДНА на клиенте — `sniffContent` из
 * fs-content.ts (та же, что у fs_read): две таблицы давали ПИНГ-ПОНГ — fs_read слал файл в file_view, а
 * file_view отсылал «это текст — читай fs_read». Здесь остаются только помощники зрения: размеры из
 * заголовка и целостность pass-through форматов.
 */
import { type SniffFormat, sniffContent } from "./fs-content.js";

export type SniffedKind = SniffFormat | "text" | "unknown";

/** Что за файл по первым байтам (единая таблица fs-content). Текст в любой кодировке/пустой файл → `text`. */
export function sniffFile(buf: Buffer): SniffedKind {
  const s = sniffContent(buf, "");
  if (s.kind !== "binary") return "text";
  return s.format ?? "unknown";
}

/** MIME для форматов, которые модель принимает как есть (Anthropic base64-image allowlist). */
export function mediaTypeOf(kind: SniffedKind): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  switch (kind) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * Размеры из заголовка БЕЗ декодирования: гейт против decode-bomb (PNG 20000×20000 в 1 МБ файла
 * аллоцирует 1,6 ГБ синхронно в main-процессе) и факт для форматов, которые nativeImage не читает.
 * JPEG — из SOF-сегмента. Не разобрали → null: «не знаю» честнее выдуманного 0×0.
 */
export function imageDimensions(kind: SniffedKind, buf: Buffer): { width: number; height: number } | null {
  try {
    if (kind === "png" && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (kind === "gif" && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (kind === "jpeg") return jpegDimensions(buf);
    if (kind === "webp" && buf.length >= 30) {
      const chunk = buf.toString("latin1", 12, 16);
      if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
    }
  } catch {
    /* усечённый заголовок — ниже вернём null */
  }
  return null;
}

/** JPEG: идём по сегментам до SOFn (C0–CF кроме C4/C8/CC), там высота/ширина. */
function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i += 1; // паддинг
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Целостность форматов, которые уходят в модель БЕЗ декодирования (gif/webp): битый/усечённый файл
 * даёт HTTP 400 на ВЕСЬ ход (стаб «связь прервалась»), поэтому рвём раньше — честной ошибкой инструмента.
 * Возвращает причину или null, если признаков обрыва нет.
 */
export function passThroughIntegrityProblem(kind: "gif" | "webp", buf: Buffer): string | null {
  if (kind === "gif") {
    if (buf.length < 14) return "файл короче заголовка GIF";
    if (buf[buf.length - 1] !== 0x3b) return "нет завершающего байта GIF (файл обрезан)";
    return null;
  }
  if (buf.length < 12) return "файл короче заголовка RIFF";
  const declared = buf.readUInt32LE(4) + 8;
  if (declared > buf.length) return `RIFF объявляет ${declared} байт, в файле ${buf.length} (файл обрезан)`;
  return null;
}
