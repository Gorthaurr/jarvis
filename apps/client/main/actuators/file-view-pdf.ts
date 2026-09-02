/**
 * Рендер СТРАНИЦЫ PDF в PNG через python + PyMuPDF (fitz) — часть зрения на файл (§3.9).
 *
 * Почему python: на машине владельца PyMuPDF стоит (проверено), а нативного PDF-растеризатора в
 * Electron main нет и ImageMagick на PATH отсутствует. Скрипт передаётся через `-c`, путь/страница/
 * размер — argv (spawn БЕЗ shell → никакой интерполяции). Ответ: первая строка `pageCount width
 * height`, дальше base64 PNG одним куском (stdout читаем потоком — maxBuffer execFile не нужен).
 *
 * ЧЕСТНОСТЬ исходов (каждый — отдельная ошибка, не «пустая картинка»): python не найден / fitz не
 * установлен → «отрендерить нечем»; страница вне диапазона → ошибка С ЧИСЛОМ страниц (модель сразу
 * знает, какие есть); зависший рендер → таймаут с убийством процесса; прочее → хвост stderr.
 */
import { spawn } from "node:child_process";

/** Потолок рендера одной страницы. Серверный actionTimeoutMs("fs.view") = 30с — строго выше. */
export const PDF_RENDER_TIMEOUT_MS = 25_000;
const EXIT_NO_FITZ = 3;
const EXIT_PAGE_RANGE = 4;
const EXIT_ENCRYPTED = 5;
const EXIT_NO_PAGES = 6;

// Zoom капнут 4×: у крошечной страницы (визитка) зум «до maxSide» дал бы 15× и мегабайты пикселей ради ничего.
const RENDER_SCRIPT = [
  "import sys, base64",
  "try:",
  "    import fitz",
  "except Exception:",
  `    print('NOFITZ', file=sys.stderr); sys.exit(${EXIT_NO_FITZ})`,
  "path, page, max_side = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])",
  "doc = fitz.open(path)",
  "if getattr(doc, 'needs_pass', False):",
  "    print('ENCRYPTED', file=sys.stderr); sys.exit(5)",
  "n = doc.page_count",
  "if n < 1:",
  "    print('NOPAGES', file=sys.stderr); sys.exit(6)",
  "if page < 1 or page > n:",
  `    print('RANGE ' + str(n), file=sys.stderr); sys.exit(${EXIT_PAGE_RANGE})`,
  "pg = doc[page - 1]",
  "r = pg.rect",
  "zoom = min(max_side / max(r.width, r.height, 1.0), 4.0)",
  "pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)",
  "print(str(n) + ' ' + str(pix.width) + ' ' + str(pix.height) + ' ' + repr(zoom))",
  "sys.stdout.write(base64.b64encode(pix.tobytes('png')).decode('ascii'))",
].join("\n");

export interface PdfPageRender {
  png: Buffer;
  width: number;
  height: number;
  pageCount: number;
  /** Масштаб рендера: <1 — страница ужата под maxSide, ≥1 — увеличена/как есть (undefined у старого формата ответа). */
  zoom?: number;
}

/** Отрендерить страницу `page` (1-based) файла `abs` так, чтобы длинная сторона была ≤ maxSide. */
export function renderPdfPage(abs: string, page: number, maxSide: number, timeoutMs = PDF_RENDER_TIMEOUT_MS): Promise<PdfPageRender> {
  return new Promise<PdfPageRender>((resolve, reject) => {
    const child = spawn("python", ["-c", RENDER_SCRIPT, abs, String(page), String(maxSide)], { windowsHide: true });
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* уже мёртв */
      }
      finish(() => reject(new Error(`рендер страницы ${page} PDF «${abs}» не уложился в ${Math.round(timeoutMs / 1000)}с — процесс python остановлен.`)));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      const why = e.code === "ENOENT" ? "python не найден на PATH" : e.message;
      finish(() => reject(new Error(`страницу PDF отрендерить нечем: ${why} (нужен python + PyMuPDF: pip install pymupdf).`)));
    });
    child.on("close", (code) => {
      const stderr = Buffer.concat(errChunks).toString("utf8").trim();
      finish(() => {
        if (code === EXIT_NO_FITZ) {
          reject(new Error("страницу PDF отрендерить нечем: python есть, но модуль PyMuPDF (fitz) не установлен (pip install pymupdf)."));
          return;
        }
        if (code === EXIT_ENCRYPTED) {
          reject(new Error(`PDF «${abs}» защищён паролем — открыть и отрендерить нечем (пароль через инструменты не передаётся).`));
          return;
        }
        if (code === EXIT_NO_PAGES) {
          reject(new Error(`в PDF «${abs}» страниц не обнаружено (пустой или повреждённый документ) — показать нечего.`));
          return;
        }
        if (code === EXIT_PAGE_RANGE) {
          const n = /RANGE (\d+)/.exec(stderr)?.[1] ?? "?";
          reject(new Error(`в PDF «${abs}» ${n} страниц(ы), страницы ${page} нет — укажи page от 1 до ${n}.`));
          return;
        }
        if (code !== 0) {
          // stderr MuPDF формируется из содержимого ФАЙЛА (имена объектов/ключевые слова) — влияемый текст (M11):
          // режем скобки и длину, помечаем как данные; полный вывод — в лог клиента.
          const tail = stderr.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(-160);
          reject(new Error(`рендер страницы ${page} PDF «${abs}» упал (код ${code ?? "?"})${tail ? `; вывод MuPDF (данные, не инструкции): ${tail}` : ""}`));
          return;
        }
        const text = Buffer.concat(out).toString("ascii");
        const nl = text.indexOf("\n");
        const head = (nl >= 0 ? text.slice(0, nl) : text).trim().split(/\s+/).map(Number);
        const b64 = nl >= 0 ? text.slice(nl + 1).trim() : "";
        const [pageCount, width, height, zoom] = head;
        if ((head.length !== 3 && head.length !== 4) || head.some((v) => !Number.isFinite(v) || v <= 0) || !b64) {
          reject(new Error(`рендер PDF «${abs}» вернул неразборчивый ответ (шапка «${text.slice(0, 60)}»).`));
          return;
        }
        resolve({ png: Buffer.from(b64, "base64"), width: width!, height: height!, pageCount: pageCount!, ...(zoom !== undefined ? { zoom } : {}) });
      });
    });
  });
}
