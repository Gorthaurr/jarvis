/**
 * fs.read над виртуальной ФС — порт `readFile`/`readWindow` из apps/client/main/actuators/fs.ts: тот же выбор кодировки
 * (utf8 / BOM / utf16 / cp1251 по эвристике), те же лимиты (2 МБ, окно 400/5000 строк, файл > 32 МБ не поднимается целиком),
 * те же честные поля (truncated/note/totalLines/range; content — последним). Чистые куски (sniff/decode/окно строк) берутся
 * из клиента импортом, а не переписываются: расхождение с боевым поведением исключено.
 */
import { extname } from "node:path";
import { cutText } from "@jarvis/shared";
import { type ContentSniff, decodeTextDetailed, sniffContent, type TextEncoding } from "../../../apps/client/main/actuators/fs-content.js";
import { HEAD_SNIFF_BYTES, type LineWindow, TAIL_CHUNK_BYTES, WINDOW_WHOLE_FILE_CAP, applyLineWindow, dropPartialFirstLine, dropPartialLastLine, hasLineWindow, splitLines, validateLineWindow } from "../../../apps/client/main/actuators/fs-read-window.js";
import type { DesktopCore } from "./core.js";
import { guardRead } from "./vfs-guard.js";
import { expandPath, readBuf, statOf, winPath } from "./vfs.js";

export const DEFAULT_MAX_READ = 2 * 1024 * 1024;

export interface ReadResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  encoding: TextEncoding;
  note?: string;
  totalLines?: number;
  range?: { from: number; to: number };
}
export interface ReadOptions {
  wholeFileCap?: number;
  tailChunkBytes?: number;
}

const binaryError = (abs: string, s: Extract<ContentSniff, { kind: "binary" }>): Error =>
  new Error(`«${winPath(abs)}» — бинарный файл (${s.type}): текстом не читается. ${s.hint}`);

export function readText(core: DesktopCore, path: string, maxBytes = DEFAULT_MAX_READ, window?: LineWindow, opts?: ReadOptions): ReadResult {
  const abs = expandPath(core, path);
  guardRead(abs);
  if (hasLineWindow(window)) return readWindow(core, abs, window, Math.max(1, maxBytes), opts);
  const st = statOf(core, abs, "stat");
  const whole = readBuf(core, abs); // каталог → EISDIR read, как у fsp.readFile после stat
  const size = st.size;
  // Большой файл целиком не поднимаем: голова в maxBytes (+4 — чтобы обрубок multibyte срезал декодер, а не эвристика cp1251).
  const buf = size > (opts?.wholeFileCap ?? WINDOW_WHOLE_FILE_CAP) ? whole.subarray(0, Math.max(1, maxBytes) + 4) : whole;
  const sniff = sniffContent(buf, extname(abs));
  if (sniff.kind === "binary") throw binaryError(abs, sniff);
  if (sniff.kind === "empty") return { path: winPath(abs), bytes: 0, truncated: false, encoding: "utf8", totalLines: 0, content: "" };
  const limit = Math.min(buf.length, Math.max(1, maxBytes));
  const truncated = size > limit;
  const decoded = decodeTextDetailed(buf, sniff, limit);
  const encoding = decoded.encoding;
  const content = truncated && encoding.startsWith("utf8") ? decoded.text.replace(/�+$/u, "") : decoded.text;
  const notes: string[] = [];
  if (encoding === "cp1251") notes.push("кодировка не UTF-8 — декодировано как cp1251 по эвристике (koi8-r/cp866 выглядели бы искажённо; тогда читать через code_run с явной кодировкой)");
  if (encoding.startsWith("utf8") && content.includes("�")) notes.push("часть байтов не декодируется как UTF-8 (в тексте «�») — возможно, файл в другой кодировке (cp1251?); читать через code_run с явной кодировкой");
  if (!truncated && encoding.startsWith("utf16") && (buf.length - sniff.bomBytes) % 2 === 1) notes.push("нечётная длина UTF-16 — последний байт файла отброшен (файл повреждён или дописан не по кодировке)");
  if (truncated) notes.push(`показаны первые ${limit} байт из ${size}; большой файл читай ОКНОМ — fs_read{offset,lines} или tail`);
  const totalLines = truncated ? undefined : splitLines(content).length;
  return { path: winPath(abs), bytes: size, truncated, encoding, ...(totalLines !== undefined ? { totalLines } : {}), ...(notes.length ? { note: notes.join("; ") } : {}), content };
}

/** Кусок с хвоста: последние maxBytes байт, начало выровнено по `align` (UTF-16 — иначе пары байт съезжают). */
function tailOf(buf: Buffer, maxBytes: number, align: number): { buf: Buffer; fromStart: boolean } {
  let start = Math.max(0, buf.length - maxBytes);
  start -= start % align;
  return { buf: buf.subarray(start), fromStart: start === 0 };
}

function readWindow(core: DesktopCore, abs: string, window: LineWindow, maxChars: number, opts?: ReadOptions): ReadResult {
  const bad = validateLineWindow(window);
  if (bad) throw new Error(bad);
  const size = statOf(core, abs, "stat").size;
  const all = readBuf(core, abs);
  const cap = opts?.wholeFileCap ?? WINDOW_WHOLE_FILE_CAP;
  const chunkBytes = opts?.tailChunkBytes ?? TAIL_CHUNK_BYTES;
  const ext = extname(abs);
  const path = winPath(abs);
  const mb = (n: number): string => `${Math.round((n / 1048576) * 10) / 10} МБ`;
  const useChunks = size > cap || (window.tail !== undefined && size > chunkBytes);
  let buf: Buffer;
  let sniff: ContentSniff;
  let mode: "whole" | "tail" | "head" = "whole";
  const notes: string[] = [];
  if (!useChunks) {
    buf = all;
    sniff = sniffContent(buf, ext);
  } else {
    const headSniff = sniffContent(all.subarray(0, HEAD_SNIFF_BYTES), ext);
    if (headSniff.kind === "binary") throw binaryError(abs, headSniff);
    if (headSniff.kind === "empty") return { path, bytes: size, truncated: false, encoding: "utf8", totalLines: 0, range: { from: 1, to: 0 }, content: "" };
    const enc = headSniff.encoding === "utf8-bom" ? "utf8" : headSniff.encoding;
    if (window.tail !== undefined) {
      mode = "tail";
      const t = tailOf(all, chunkBytes, enc.startsWith("utf16") ? 2 : 1);
      const aligned = t.fromStart ? t.buf : dropPartialFirstLine(t.buf, enc);
      if (aligned === null) {
        return { path, bytes: size, truncated: true, encoding: enc, note: `файл ${mb(size)} — прочитан только хвост (${mb(chunkBytes)}), и в нём нет ни одной полной строки: строки длиннее куска (минифицированный JSON/одна строка?). Читай через code_run.`, content: "" };
      }
      buf = aligned;
      sniff = t.fromStart ? headSniff : { kind: "text", encoding: enc, bomBytes: 0 };
      if (!t.fromStart) notes.push(`файл ${mb(size)} — прочитан только хвост (${mb(buf.length)}); номера строк от начала файла не считаются`);
      else mode = "whole";
    } else if (window.offset === undefined) {
      mode = "head";
      const headChunk = all.subarray(0, chunkBytes);
      sniff = headSniff;
      if (headChunk.length >= size) {
        buf = headChunk;
        mode = "whole";
      } else {
        const trimmed = dropPartialLastLine(headChunk, enc);
        if (trimmed === null) {
          return { path, bytes: size, truncated: true, encoding: enc, note: `файл ${mb(size)} — прочитано только начало (${mb(chunkBytes)}), и в нём нет ни одной полной строки: строки длиннее куска. Читай через code_run.`, content: "" };
        }
        buf = trimmed;
        notes.push(`файл ${mb(size)} — прочитано только начало (${mb(buf.length)}); дальше по offset на таком файле не читаю: хвост — fs_read{tail}, произвольный кусок — code_run`);
      }
    } else {
      throw new Error(
        `«${path}» — ${mb(size)}, больше ${mb(cap)}: окно по offset на таком файле не читаю (пришлось бы поднять его целиком). ` +
          "Начало — fs_read{lines:N}; хвост — fs_read{tail:N}; произвольный кусок — code_run (python: itertools.islice по строкам / PowerShell Get-Content -TotalCount|-Tail).",
      );
    }
  }
  if (sniff.kind === "binary") throw binaryError(abs, sniff);
  if (sniff.kind === "empty") return { path, bytes: size, truncated: false, encoding: "utf8", totalLines: 0, range: { from: 1, to: 0 }, content: "" };
  const decoded = decodeTextDetailed(buf, sniff, buf.length);
  if (decoded.encoding === "cp1251") notes.push("кодировка не UTF-8 — декодировано как cp1251 по эвристике");
  if (mode === "whole" && decoded.encoding.startsWith("utf16") && (buf.length - sniff.bomBytes) % 2 === 1) notes.push("нечётная длина UTF-16 — последний байт файла отброшен (файл повреждён или дописан не по кодировке)");
  const w = applyLineWindow(decoded.text, window);
  let content = w.content;
  let truncated = !w.complete || mode !== "whole";
  if (content.length > maxChars) {
    content = cutText(content, maxChars);
    truncated = true;
    notes.push(`окно обрезано до ${maxChars} символов (maxBytes) — уменьши lines`);
  }
  if (mode === "whole" && w.note) notes.push(w.note);
  if (mode === "head" && !w.complete) notes.push(`показаны строки 1–${w.to} начала файла`);
  return {
    path, bytes: size, truncated, encoding: decoded.encoding,
    ...(mode === "whole" ? { totalLines: w.totalLines, range: { from: w.from, to: w.to } } : mode === "head" ? { range: { from: 1, to: w.to } } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
    content,
  };
}
