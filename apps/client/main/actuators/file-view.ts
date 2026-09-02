/**
 * Зрение на файл (§3.9, ActionCommand fs.view): картинку или страницу PDF с диска → base64 для
 * vision-модели. Закрывает единственную дыру зрения: раньше image-блок собирался только из
 * screen_capture/MCP, а `fs_read` на картинке отдавал utf8-мусор.
 *
 * Законы: тип — ПО СИГНАТУРЕ (file-sniff), не по расширению; путь приходит ОТ МОДЕЛИ → assertReadable
 * (секреты не утекают в облако); любой провал — ИСКЛЮЧЕНИЕ с русской причиной (dispatch превратит в
 * error.runtime), никаких «пустых картинок». Размер под модель: длинная сторона ≤ maxSide (деф 1568,
 * как screen.ts), base64 ≤ ~3.5MB (кап Anthropic 5MB с запасом).
 *
 * Ревью 2026-09-01 (ресурсы/честность): stat ДО чтения (не поднимаем гигабайтный «mkv» в память ради
 * отказа); гейт по мегапикселям ДО декодирования (decode-bomb морозил main-процесс — слух/IPC/WS);
 * GIF/WEBP уходят как есть только целыми и ≤ 8000 px (Anthropic отвергает крупнее → 400 на весь ход);
 * JPEG-исходник после ужатия кодируется в JPEG, не в PNG (живьём: 425 КБ PNG против 148 КБ JPEG).
 */
import { nativeImage } from "electron";
import { promises as fsp } from "node:fs";
import { extname } from "node:path";
import { createLogger } from "@jarvis/shared";
import { expandPath } from "./fs.js";
import { assertReadable } from "./self-guard.js";
import { type SniffedKind, imageDimensions, mediaTypeOf, passThroughIntegrityProblem, sniffFile } from "./file-sniff.js";
import { renderPdfPage } from "./file-view-pdf.js";

const log = createLogger("actuator:file-view");

/** Длинная сторона по умолчанию — как MAX_EDGE в screen.ts (больше модель всё равно ужмёт сама). */
export const DEFAULT_MAX_SIDE = 1568;
const MIN_MAX_SIDE = 256;
/** Кап входного файла: картинка/PDF крупнее 32 МБ — не «посмотреть», а обработать другим путём. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
/** Кап base64 под лимит Anthropic (5MB) с запасом. */
const MAX_B64_CHARS = 3_500_000;
/** Гейт против decode-bomb: декодируем синхронно в main-процессе, 50 МП — потолок здравого смысла. */
const MAX_PIXELS = 50_000_000;
/** Anthropic отвергает изображения крупнее 8000 px по стороне (400 на весь запрос). */
const MAX_MODEL_SIDE = 8000;
const JPEG_QUALITY = 80;

export interface FileViewResult {
  path: string;
  image: string; // base64
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
  format: SniffedKind;
  bytes: number; // размер ИСХОДНОГО файла
  page?: number;
  pageCount?: number;
  /** Ужато под maxSide/кап модели (у PDF — рендер с zoom<1). */
  resized: boolean;
  /** Страница PDF отрендерена (это всегда рендер, не исходные пиксели). */
  rendered?: boolean;
  /** Честная пометка для модели (например, «maxSide не применён»). */
  note?: string;
}

export interface FileViewOpts {
  page?: number;
  maxSide?: number;
}

const b64Len = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export async function viewFile(path: string, opts: FileViewOpts = {}): Promise<FileViewResult> {
  const abs = expandPath(path);
  assertReadable(abs); // §0: секреты (ключи/креды) в контекст модели не уходят — и картинкой тоже
  const maxSide = Math.max(MIN_MAX_SIDE, Math.min(DEFAULT_MAX_SIDE, Math.round(opts.maxSide ?? DEFAULT_MAX_SIDE)));
  // stat ДО чтения: размер и «это файл?» узнаём без подъёма содержимого в память.
  let size: number;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error(`«${abs}» — не файл (каталог/спецобъект), показать нечего.`);
    size = st.size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`не удалось прочитать «${abs}»: файла нет`);
    if (e instanceof Error && /не файл/u.test(e.message)) throw e;
    throw new Error(`не удалось прочитать «${abs}»: ${(e as Error).message}`);
  }
  if (size > MAX_INPUT_BYTES) {
    throw new Error(`файл «${abs}» слишком велик для просмотра (${Math.round(size / 1048576)} МБ > ${MAX_INPUT_BYTES / 1048576} МБ) — ужми/раздели через code_run.`);
  }
  const buf = await fsp.readFile(abs);
  const kind = sniffFile(buf);
  log.info("fs.view", { path: abs, kind, bytes: buf.length, page: opts.page, maxSide });
  switch (kind) {
    case "png":
    case "jpeg":
      return viewRaster(abs, buf, kind, maxSide);
    case "gif":
    case "webp":
      return viewPassThrough(abs, buf, kind, maxSide);
    case "pdf":
      return viewPdf(abs, buf.length, opts.page ?? 1, maxSide);
    default:
      throw new Error(unsupportedMessage(abs, kind));
  }
}

/** PNG/JPEG: гейт по пикселям из заголовка → декодировать (факт «это картинка») → ужать → упаковать. */
function viewRaster(abs: string, buf: Buffer, kind: "png" | "jpeg", maxSide: number): FileViewResult {
  const header = imageDimensions(kind, buf);
  if (header && header.width * header.height > MAX_PIXELS) {
    throw new Error(
      `«${abs}» слишком большая картинка (${header.width}×${header.height}) — декодировать её целиком нельзя без заморозки клиента; ужми через code_run (Pillow) и посмотри копию.`,
    );
  }
  const img = nativeImage.createFromBuffer(buf);
  const size = img.isEmpty() ? { width: 0, height: 0 } : img.getSize();
  if (size.width <= 0 || size.height <= 0) {
    throw new Error(`«${abs}» по сигнатуре ${kind.toUpperCase()}, но не декодировалось (битый/усечённый файл) — показать нечего.`);
  }
  const scale = Math.min(1, maxSide / Math.max(size.width, size.height));
  const base = { path: abs, format: kind, bytes: buf.length };
  if (scale === 1 && b64Len(buf.length) <= MAX_B64_CHARS && Math.max(size.width, size.height) <= MAX_MODEL_SIDE) {
    return { ...base, image: buf.toString("base64"), mediaType: mediaTypeOf(kind)!, width: size.width, height: size.height, resized: false };
  }
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const out = scale < 1 ? img.resize({ width, height }) : img;
  return { ...base, ...encodeForModel(abs, out, kind === "jpeg"), width, height, resized: scale < 1 };
}

/**
 * GIF/WEBP: nativeImage их не читает — отдаём байты как есть, но ТОЛЬКО целые, с разобранным заголовком и в
 * лимите модели по пикселям; иначе 400 на весь ход вместо честной ошибки инструмента.
 */
function viewPassThrough(abs: string, buf: Buffer, kind: "gif" | "webp", maxSide: number): FileViewResult {
  const up = kind.toUpperCase();
  const problem = passThroughIntegrityProblem(kind, buf);
  if (problem) throw new Error(`«${abs}» (${up}) повреждён: ${problem} — модель такой файл отвергнет; перекодируй через code_run (Pillow).`);
  const dims = imageDimensions(kind, buf);
  if (!dims) throw new Error(`«${abs}» (${up}): заголовок не разобран (битый или экзотический вариант) — перекодируй в PNG через code_run (Pillow) и посмотри его.`);
  const longSide = Math.max(dims.width, dims.height);
  if (longSide > MAX_MODEL_SIDE) {
    throw new Error(`«${abs}» (${up}, ${dims.width}×${dims.height}) крупнее лимита модели ${MAX_MODEL_SIDE} px, а перекодировать ${up} на клиенте нечем — ужми через code_run (Pillow).`);
  }
  if (b64Len(buf.length) > MAX_B64_CHARS) {
    throw new Error(
      `«${abs}» (${up}, ${Math.round(buf.length / 1024)} КБ) слишком большой для модели, а конвертировать ${up} на клиенте нечем — сконвертируй в PNG через code_run (Pillow) и посмотри его.`,
    );
  }
  const note = longSide > maxSide ? `maxSide=${maxSide} не применён: ${up} не перекодируется на клиенте, отдан как есть (${dims.width}×${dims.height})` : undefined;
  return { path: abs, image: buf.toString("base64"), mediaType: mediaTypeOf(kind)!, ...dims, format: kind, bytes: buf.length, resized: false, ...(note ? { note } : {}) };
}

async function viewPdf(abs: string, bytes: number, page: number, maxSide: number): Promise<FileViewResult> {
  if (!Number.isInteger(page) || page < 1) throw new Error(`page должен быть целым числом от 1 (получено ${String(page)}).`);
  const r = await renderPdfPage(abs, page, maxSide);
  const packed =
    b64Len(r.png.length) <= MAX_B64_CHARS
      ? { image: r.png.toString("base64"), mediaType: "image/png" as const }
      : encodeForModel(abs, nativeImage.createFromBuffer(r.png), false);
  // resized — ТОЛЬКО когда страница реально ужата (zoom<1); увеличенная визитка «ужатой» не называется.
  const resized = r.zoom !== undefined ? r.zoom < 1 : true;
  return { path: abs, ...packed, width: r.width, height: r.height, format: "pdf", bytes, page, pageCount: r.pageCount, resized, rendered: true };
}

/** Упаковать под кап модели. Фото (JPEG-исходник) — сразу JPEG; PNG/PDF-страница (текст, линии) — PNG, не влезло → JPEG. */
function encodeForModel(abs: string, img: Electron.NativeImage, preferJpeg: boolean): { image: string; mediaType: "image/png" | "image/jpeg" } {
  const tryJpeg = (): { image: string; mediaType: "image/jpeg" } | null => {
    const jpeg = img.toJPEG(JPEG_QUALITY);
    return jpeg.length > 0 && b64Len(jpeg.length) <= MAX_B64_CHARS ? { image: jpeg.toString("base64"), mediaType: "image/jpeg" } : null;
  };
  const tryPng = (): { image: string; mediaType: "image/png" } | null => {
    const png = img.toPNG();
    return png.length > 0 && b64Len(png.length) <= MAX_B64_CHARS ? { image: png.toString("base64"), mediaType: "image/png" } : null;
  };
  const out = preferJpeg ? (tryJpeg() ?? tryPng()) : (tryPng() ?? tryJpeg());
  if (out) return out;
  throw new Error(`«${abs}» не влезает в лимит модели даже после сжатия в JPEG — уменьши maxSide.`);
}

/** Не картинка и не PDF: назвать тип и ПРАВИЛЬНЫЙ инструмент, а не «не поддерживается». */
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
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
    return head + "Расширение картинки, но содержимое ей не является (битый или переименованный файл) — перекодируй через code_run (Pillow), если это вообще изображение.";
  }
  return head + "Картинку сконвертируй в PNG/JPG через code_run (Pillow), текст читай fs_read, документы — office_word/office_excel.";
}
