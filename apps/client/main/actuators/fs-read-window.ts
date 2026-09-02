/**
 * ОКНО СТРОК для fs.read (причина №6 USER_SCENARIOS_2026-09-02: «fs_read без tail/offset»).
 *
 * Лог на 40 МБ или файл на 12 000 строк либо не влезал в контекст, либо резался по maxBytes с ПЕРВЫХ
 * байт — а модели чаще нужен ХВОСТ лога (последняя ошибка) или конкретный диапазон строк (после
 * fs_search «нашлось в строке 3412»). Здесь — ЧИСТЫЙ выбор диапазона по уже декодированному тексту и
 * честный отчёт: totalLines, range, note с ГОТОВЫМ offset для следующего куска. Окно за концом файла —
 * не ошибка, а пустое content с note «в файле всего N строк» (иначе модель гадала бы, кончился ли файл).
 *
 * Огромный файл (больше WINDOW_WHOLE_FILE_CAP) целиком в память не поднимаем: для tail читается только
 * последний кусок (readTailBytes), для offset — честная ошибка с каналом (code_run).
 */
import { promises as fsp } from "node:fs";

export interface LineWindow {
  /** Номер ПЕРВОЙ строки окна, с 1. */
  offset?: number;
  /** Сколько строк отдать (с offset; по умолчанию DEFAULT_WINDOW_LINES). */
  lines?: number;
  /** Последние N строк файла. Несовместимо с offset. */
  tail?: number;
}
export interface WindowedText {
  content: string;
  totalLines: number;
  /** Диапазон показанных строк (1-based, включительно); пустое окно → to < from. */
  from: number;
  to: number;
  /** true — показан ВЕСЬ файл (окно покрыло всё). */
  complete: boolean;
  note?: string;
}

export const DEFAULT_WINDOW_LINES = 400;
export const MAX_WINDOW_LINES = 5000;
/** Файлы крупнее целиком в память не читаем (окно всё равно маленькое) — 32 МБ. */
export const WINDOW_WHOLE_FILE_CAP = 32 * 1024 * 1024;
/** Для tail на огромном файле читается только этот хвост в байтах. */
export const TAIL_CHUNK_BYTES = 4 * 1024 * 1024;

export function hasLineWindow(w: LineWindow | undefined): w is LineWindow {
  return Boolean(w && (w.offset !== undefined || w.lines !== undefined || w.tail !== undefined));
}

/** Проверка параметров окна: текст ошибки по-русски (идёт модели как есть) или null. */
export function validateLineWindow(w: LineWindow): string | null {
  if (w.tail !== undefined && w.offset !== undefined) {
    return "fs.read: tail и offset вместе не имеют смысла — либо хвост (tail), либо окно с offset";
  }
  for (const [k, v] of Object.entries(w) as Array<[string, unknown]>) {
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1)) return `fs.read: ${k} должен быть целым числом ≥ 1`;
  }
  return null;
}

/** Разбить на строки: хвостовой перенос не образует лишнюю пустую «строку». */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const all = text.split(/\r?\n/);
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  return all;
}

export function applyLineWindow(text: string, w: LineWindow): WindowedText {
  const all = splitLines(text);
  const total = all.length;
  if (total === 0) return { content: "", totalLines: 0, from: 1, to: 0, complete: true };
  let from: number;
  let to: number;
  if (w.tail !== undefined) {
    const n = Math.min(MAX_WINDOW_LINES, w.tail);
    from = Math.max(1, total - n + 1);
    to = total;
  } else {
    from = w.offset ?? 1;
    const count = Math.min(MAX_WINDOW_LINES, w.lines ?? DEFAULT_WINDOW_LINES);
    to = Math.min(total, from + count - 1);
  }
  if (from > total) {
    return { content: "", totalLines: total, from, to: from - 1, complete: false, note: `окно за концом файла: в файле всего ${total} строк(и), а offset=${from}` };
  }
  const content = all.slice(from - 1, to).join("\n");
  const complete = from === 1 && to === total;
  const notes: string[] = [];
  if (!complete) {
    notes.push(`показаны строки ${from}–${to} из ${total}`);
    if (to < total) notes.push(`следующий кусок: offset=${to + 1}`);
    if (from > 1) notes.push(`выше ещё ${from - 1} строк(и)${w.tail !== undefined ? " (это хвост файла)" : ""}`);
  }
  return { content, totalLines: total, from, to, complete, ...(notes.length ? { note: notes.join("; ") } : {}) };
}

/** Сколько байт головы читаем ради BOM/кодировки, когда файл целиком не поднимаем. */
export const HEAD_SNIFF_BYTES = 8192;

/** Первые n байт файла (голова: BOM/кодировка; начало огромного файла для lines без offset). */
export async function readHeadBytes(abs: string, n: number): Promise<Buffer> {
  const fh = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(n);
    let done = 0;
    while (done < n) {
      const { bytesRead } = await fh.read(buf, done, n - done, done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return buf.subarray(0, done);
  } finally {
    await fh.close();
  }
}

/**
 * Хвостовой кусок начат посреди строки — а для UTF-8 ещё и посреди СИМВОЛА. Срезаем всё до первого полного
 * перевода строки НА УРОВНЕ БАЙТОВ, чтобы декодер не видел обрубка: ревью (HIGH) показало, что ведущий «�» от
 * обрубка включал эвристику cp1251 и кириллический лог >32 МБ уезжал моджибейком с ложной encoding:"cp1251".
 * UTF-16: перевод строки — пара байт на чётной позиции (кусок выровнен заранее, см. readTailBytes align).
 * null — в куске нет ни одной полной строки (строка длиннее куска).
 */
export function dropPartialFirstLine(buf: Buffer, encoding: "utf8" | "utf16le" | "utf16be" | "cp1251"): Buffer | null {
  if (encoding === "utf16le" || encoding === "utf16be") {
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const lo = encoding === "utf16le" ? buf[i] : buf[i + 1];
      const hi = encoding === "utf16le" ? buf[i + 1] : buf[i];
      if (lo === 0x0a && hi === 0x00) return buf.subarray(i + 2);
    }
    return null;
  }
  const nl = buf.indexOf(0x0a);
  return nl >= 0 ? buf.subarray(nl + 1) : null;
}

/**
 * Голова файла обрывается посреди строки (и символа): срезаем хвост куска до последнего ПОЛНОГО перевода строки —
 * иначе хвостовой «�» от обрубка включает ту же ложную cp1251 (второй заход того же класса, что и dropPartialFirstLine).
 * null — в куске нет ни одного перевода строки.
 */
export function dropPartialLastLine(buf: Buffer, encoding: "utf8" | "utf16le" | "utf16be" | "cp1251"): Buffer | null {
  if (encoding === "utf16le" || encoding === "utf16be") {
    for (let i = buf.length - (buf.length % 2) - 2; i >= 0; i -= 2) {
      const lo = encoding === "utf16le" ? buf[i] : buf[i + 1];
      const hi = encoding === "utf16le" ? buf[i + 1] : buf[i];
      if (lo === 0x0a && hi === 0x00) return buf.subarray(0, i + 2);
    }
    return null;
  }
  const nl = buf.lastIndexOf(0x0a);
  return nl >= 0 ? buf.subarray(0, nl + 1) : null;
}

/**
 * Последние maxBytes байт файла (tail на большом файле). fromStart=true — прочитан весь файл. align=2 держит
 * начало куска на чётной позиции файла (UTF-16: иначе пары байт съезжают и текст превращается в иероглифы).
 */
export async function readTailBytes(abs: string, size: number, maxBytes: number, align = 1): Promise<{ buf: Buffer; fromStart: boolean }> {
  let start = Math.max(0, size - maxBytes);
  start -= start % align;
  const fh = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(size - start);
    let done = 0;
    while (done < buf.length) {
      const { bytesRead } = await fh.read(buf, done, buf.length - done, start + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return { buf: done === buf.length ? buf : buf.subarray(0, done), fromStart: start === 0 };
  } finally {
    await fh.close();
  }
}
