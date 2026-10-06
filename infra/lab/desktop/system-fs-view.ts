/**
 * fs.view над виртуальной ФС — порт `viewFile` (file-view.ts) БЕЗ Electron: тип файла по сигнатуре, те же гейты и тексты
 * отказов, размеры — из заголовка. Чего лаборатория НЕ умеет (и говорит об этом, а не изображает): перекодировать/ужимать
 * картинку (нет nativeImage) — отдаётся оригинал с `note`; отрендерить страницу PDF (нужен PyMuPDF) — честная ошибка.
 */
import { extname } from "node:path";
import { imageDimensions, mediaTypeOf, passThroughIntegrityProblem, sniffFile, type SniffedKind } from "../../../apps/client/main/actuators/file-sniff.js";
import type { DesktopCore } from "./core.js";
import { guardRead } from "./vfs-guard.js";
import { expandPath, tryStat, winPath } from "./vfs.js";

const DEFAULT_MAX_SIDE = 1568;
const MIN_MAX_SIDE = 256;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_B64_CHARS = 3_500_000;
const MAX_PIXELS = 50_000_000;
const MAX_MODEL_SIDE = 8000;
const b64Len = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export interface ViewResult {
  path: string;
  image: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
  format: SniffedKind;
  bytes: number;
  resized: boolean;
  note?: string;
}

/** Файл «декодировался бы»: у PNG есть завершающий IEND, у JPEG — маркер конца FFD9 (усечённые файлы клиент отвергает). */
function looksDecodable(kind: "png" | "jpeg", buf: Buffer): boolean {
  return kind === "png" ? buf.includes(Buffer.from("IEND", "latin1")) : buf.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2;
}

function unsupportedMessage(abs: string, kind: SniffedKind): string {
  const ext = extname(abs).toLowerCase();
  const head = `«${abs}» — не картинка и не PDF (по сигнатуре: ${kind}${ext ? `, расширение ${ext}` : ""}). `;
  if (kind === "text") return head + "Это текст — читай fs_read.";
  if (kind === "zip") {
    if (ext === ".docx") return head + "Это документ Word — читай office_word.";
    if (ext === ".xlsx" || ext === ".xlsm") return head + "Это книга Excel — читай office_excel.";
    if (ext === ".pptx") return head + "Это презентация PowerPoint — читай через code_run (python-pptx) или рендер страницы в PNG.";
    return head + "Это zip-архив — распакуй через code_run и посмотри нужный файл.";
  }
  if (kind === "bmp") return head + "BMP модель не принимает — сконвертируй в PNG через code_run (Pillow) и посмотри его.";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return head + "Расширение картинки, но содержимое ей не является (битый или переименованный файл) — перекодируй через code_run (Pillow), если это вообще изображение.";
  return head + "Картинку сконвертируй в PNG/JPG через code_run (Pillow), текст читай fs_read, документы — office_word/office_excel.";
}

export function viewVirtual(core: DesktopCore, path: string, opts: { page?: number; maxSide?: number } = {}): ViewResult {
  const abs = expandPath(core, path);
  guardRead(abs);
  const shown = winPath(abs);
  const maxSide = Math.max(MIN_MAX_SIDE, Math.min(DEFAULT_MAX_SIDE, Math.round(opts.maxSide ?? DEFAULT_MAX_SIDE)));
  const st = tryStat(core, abs);
  if (!st) throw new Error(`не удалось прочитать «${shown}»: файла нет`);
  if (st.kind !== "file") throw new Error(`«${shown}» — не файл (каталог/спецобъект), показать нечего.`);
  if (st.size > MAX_INPUT_BYTES) throw new Error(`файл «${shown}» слишком велик для просмотра (${Math.round(st.size / 1048576)} МБ > ${MAX_INPUT_BYTES / 1048576} МБ) — ужми/раздели через code_run.`);
  const buf = core.fs.files.get(st.p) ?? Buffer.alloc(0);
  const kind = sniffFile(buf);
  const base = { path: shown, format: kind, bytes: buf.length };
  switch (kind) {
    case "png":
    case "jpeg": {
      const dims = imageDimensions(kind, buf);
      if (dims && dims.width * dims.height > MAX_PIXELS) throw new Error(`«${shown}» слишком большая картинка (${dims.width}×${dims.height}) — декодировать её целиком нельзя без заморозки клиента; ужми через code_run (Pillow) и посмотри копию.`);
      if (!dims || dims.width <= 0 || dims.height <= 0 || !looksDecodable(kind, buf)) throw new Error(`«${shown}» по сигнатуре ${kind.toUpperCase()}, но не декодировалось (битый/усечённый файл) — показать нечего.`);
      const long = Math.max(dims.width, dims.height);
      const needsRecode = long > maxSide || b64Len(buf.length) > MAX_B64_CHARS || long > MAX_MODEL_SIDE;
      return { ...base, image: buf.toString("base64"), mediaType: mediaTypeOf(kind)!, ...dims, resized: false, ...(needsRecode ? { note: `лаборатория не перекодирует картинки: клиент ужал бы до maxSide=${maxSide}, здесь отдан оригинал ${dims.width}×${dims.height}` } : {}) };
    }
    case "gif":
    case "webp": {
      const up = kind.toUpperCase();
      const problem = passThroughIntegrityProblem(kind, buf);
      if (problem) throw new Error(`«${shown}» (${up}) повреждён: ${problem} — модель такой файл отвергнет; перекодируй через code_run (Pillow).`);
      const dims = imageDimensions(kind, buf);
      if (!dims) throw new Error(`«${shown}» (${up}): заголовок не разобран (битый или экзотический вариант) — перекодируй в PNG через code_run (Pillow) и посмотри его.`);
      const long = Math.max(dims.width, dims.height);
      if (long > MAX_MODEL_SIDE) throw new Error(`«${shown}» (${up}, ${dims.width}×${dims.height}) крупнее лимита модели ${MAX_MODEL_SIDE} px, а перекодировать ${up} на клиенте нечем — ужми через code_run (Pillow).`);
      if (b64Len(buf.length) > MAX_B64_CHARS) throw new Error(`«${shown}» (${up}, ${Math.round(buf.length / 1024)} КБ) слишком большой для модели, а конвертировать ${up} на клиенте нечем — сконвертируй в PNG через code_run (Pillow) и посмотри его.`);
      const note = long > maxSide ? `maxSide=${maxSide} не применён: ${up} не перекодируется на клиенте, отдан как есть (${dims.width}×${dims.height})` : undefined;
      return { ...base, image: buf.toString("base64"), mediaType: mediaTypeOf(kind)!, ...dims, resized: false, ...(note ? { note } : {}) };
    }
    case "pdf":
      if (!Number.isInteger(opts.page ?? 1) || (opts.page ?? 1) < 1) throw new Error(`page должен быть целым числом от 1 (получено ${String(opts.page)}).`);
      throw new Error(`«${shown}» — PDF: рендер страницы в лаборатории недоступен (нужны python и PyMuPDF на ПК); проверить fs.view по PDF можно только живьём.`);
    default:
      throw new Error(unsupportedMessage(shown, kind));
  }
}
