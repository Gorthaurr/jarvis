/**
 * §3.9 зрение на файл — клиентский актуатор viewFile: тип ПО СИГНАТУРЕ, честные ошибки на каждом
 * исходе, ужатие под модель, PDF через python+PyMuPDF. Мокаются ТОЛЬКО листья (electron.nativeImage,
 * спавн python) — сигнатуры и файлы РЕАЛЬНЫЕ (временный каталог), assertReadable реальный.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Listener = (...a: unknown[]) => void;

const st = vi.hoisted(() => {
  // Мини-эмиттер вместо node:events: фабрика vi.mock хойстится выше импортов.
  class Em {
    private h: Record<string, Listener[]> = {};
    on(ev: string, fn: Listener): this {
      (this.h[ev] ??= []).push(fn);
      return this;
    }
    emit(ev: string, ...a: unknown[]): void {
      for (const f of this.h[ev] ?? []) f(...a);
    }
  }
  /** Сценарий фейкового python: что писать в stdout/stderr и с каким кодом выйти; hang — не выходить. */
  type Script = { stdout?: string; stderr?: string; code?: number; enoent?: boolean; hang?: boolean };
  const s = {
    Em,
    imgSize: { width: 800, height: 600 },
    empty: false,
    resizeCalls: [] as Array<{ width: number; height: number }>,
    pngOut: Buffer.from("PNGOUT"),
    jpegOut: Buffer.from("JPEGOUT"),
    jpegQ: -1,
    script: { stdout: "", code: 0 } as Script,
    spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
    killCalls: 0,
    makeImg(size: { width: number; height: number }): unknown {
      return {
        isEmpty: () => s.empty,
        getSize: () => size,
        resize: (o: { width: number; height: number }) => {
          s.resizeCalls.push(o);
          return s.makeImg(o);
        },
        toPNG: () => s.pngOut,
        toJPEG: (q: number) => {
          s.jpegQ = q;
          return s.jpegOut;
        },
      };
    },
  };
  return s;
});

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: (_b: Buffer) => st.makeImg(st.imgSize) },
}));

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    st.spawnCalls.push({ cmd, args });
    const child = new st.Em() as InstanceType<typeof st.Em> & { stdout: InstanceType<typeof st.Em>; stderr: InstanceType<typeof st.Em>; kill: () => void };
    child.stdout = new st.Em();
    child.stderr = new st.Em();
    child.kill = () => {
      st.killCalls += 1;
    };
    const sc = st.script;
    setTimeout(() => {
      if (sc.hang) return;
      if (sc.enoent) {
        child.emit("error", Object.assign(new Error("spawn python ENOENT"), { code: "ENOENT" }));
        return;
      }
      if (sc.stdout) child.stdout.emit("data", Buffer.from(sc.stdout));
      if (sc.stderr) child.stderr.emit("data", Buffer.from(sc.stderr));
      child.emit("close", sc.code ?? 0);
    }, 0);
    return child;
  },
}));

import { viewFile } from "./file-view.js";
import { renderPdfPage } from "./file-view-pdf.js";

// ── Реальные файлы с реальными сигнатурами ───────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "jarvis-file-view-"));
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngBytes(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(16);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([PNG_SIG, ihdr, Buffer.alloc(64, 7)]);
}
function gifBytes(w: number, h: number, pad: number): Buffer {
  const head = Buffer.alloc(10);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(w, 6);
  head.writeUInt16LE(h, 8);
  return Buffer.concat([head, Buffer.alloc(pad, 1), Buffer.from([0x3b])]); // 0x3B — трейлер GIF (целостность)
}
const files = {
  png: join(dir, "shot.png"),
  jpg: join(dir, "photo.jpg"),
  pdf: join(dir, "report.pdf"),
  docx: join(dir, "letter.docx"),
  txt: join(dir, "notes.txt"),
  gifSmall: join(dir, "anim.gif"),
  gifBig: join(dir, "huge.gif"),
  fakePng: join(dir, "actually-jpeg.png"),
  gifCut: join(dir, "cut.gif"),
  gifWide: join(dir, "wide.gif"),
  pngBomb: join(dir, "bomb.png"),
  bmp: join(dir, "scan.bmp"),
  xlsx: join(dir, "book.xlsx"),
  pptx: join(dir, "deck.pptx"),
  bin: join(dir, "blob.bin"),
  pngHdr: join(dir, "hdr-mismatch.png"),
};
writeFileSync(files.png, pngBytes(800, 600));
writeFileSync(files.jpg, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]));
writeFileSync(files.pdf, Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n", "latin1"));
writeFileSync(files.docx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0)]));
writeFileSync(files.txt, "просто заметки\nвторая строка\n", "utf8");
writeFileSync(files.gifSmall, gifBytes(320, 240, 100));
writeFileSync(files.gifBig, gifBytes(4000, 3000, 2_700_000)); // base64 > 3.5MB
writeFileSync(files.fakePng, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(16, 5)])); // JPEG под именем .png
writeFileSync(files.gifCut, gifBytes(320, 240, 100).subarray(0, 60)); // без трейлера 0x3B — обрезан
writeFileSync(files.gifWide, gifBytes(9000, 100, 100)); // крупнее лимита модели 8000 px
writeFileSync(files.pngBomb, pngBytes(20000, 20000)); // 400 МП по заголовку — decode-bomb
writeFileSync(files.bmp, Buffer.concat([Buffer.from("BM", "latin1"), Buffer.alloc(64, 0)])); // BM + бинарное тело
writeFileSync(files.xlsx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0)]));
writeFileSync(files.pptx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0)]));
writeFileSync(files.bin, Buffer.concat([Buffer.from([0x01, 0x02, 0x00, 0x03]), Buffer.alloc(32, 0)])); // бинарник без сигнатуры
writeFileSync(files.pngHdr, pngBytes(640, 480)); // заголовок 640×480, декодер (мок) скажет 800×600
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  st.imgSize = { width: 800, height: 600 };
  st.empty = false;
  st.resizeCalls = [];
  st.pngOut = Buffer.from("PNGOUT");
  st.jpegOut = Buffer.from("JPEGOUT");
  st.jpegQ = -1;
  st.script = { stdout: "", code: 0 };
  st.spawnCalls = [];
  st.killCalls = 0;
});

describe("viewFile — картинки (PNG/JPEG через nativeImage)", () => {
  it("PNG в пределах maxSide → байты как есть (без перекодирования), resized:false, размер из декодера", async () => {
    const r = await viewFile(files.png);
    expect(r.mediaType).toBe("image/png");
    expect(r.format).toBe("png");
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    expect(r.resized).toBe(false);
    expect(r.image).toBe(pngBytes(800, 600).toString("base64"));
    expect(r.bytes).toBe(pngBytes(800, 600).length);
    expect(st.resizeCalls).toEqual([]);
  });

  it("длинная сторона > maxSide → resize пропорционально, resized:true, вывод — PNG из энкодера", async () => {
    st.imgSize = { width: 4000, height: 3000 };
    const r = await viewFile(files.png);
    expect(st.resizeCalls).toEqual([{ width: 1568, height: 1176 }]);
    expect(r.resized).toBe(true);
    expect(r.width).toBe(1568);
    expect(r.height).toBe(1176);
    expect(r.image).toBe(Buffer.from("PNGOUT").toString("base64"));
    expect(r.mediaType).toBe("image/png");
  });

  it("явный maxSide уважается (дешевле по токенам), но не ниже 256", async () => {
    st.imgSize = { width: 1000, height: 500 };
    const r = await viewFile(files.png, { maxSide: 500 });
    expect(st.resizeCalls).toEqual([{ width: 500, height: 250 }]);
    expect(r.width).toBe(500);
  });

  it("PNG не влезает в кап base64 даже без resize → JPEG q80 (кап Anthropic 5MB)", async () => {
    st.imgSize = { width: 1500, height: 1500 };
    st.pngOut = Buffer.alloc(3_000_000, 1); // base64 ≈ 4MB > 3.5MB
    // Исходный файл мал, но представим большой: подменим чтение через большой PNG на диске.
    const big = join(dir, "big.png");
    writeFileSync(big, Buffer.concat([pngBytes(1500, 1500), Buffer.alloc(2_800_000, 9)]));
    const r = await viewFile(big);
    expect(r.mediaType).toBe("image/jpeg");
    expect(r.image).toBe(Buffer.from("JPEGOUT").toString("base64"));
    expect(r.resized).toBe(false);
  });

  it("сигнатура PNG, но декодер вернул пустую картинку → честная ошибка «не декодировалось»", async () => {
    st.empty = true;
    await expect(viewFile(files.png)).rejects.toThrow(/не декодировалось/u);
  });

  it("тип — по СОДЕРЖИМОМУ: JPEG под именем .png отдаётся как image/jpeg", async () => {
    const r = await viewFile(files.fakePng);
    expect(r.format).toBe("jpeg");
    expect(r.mediaType).toBe("image/jpeg");
  });
});

describe("viewFile — гейты ресурсов и честность формата (ревью 2026-09-01)", () => {
  it("maxSide ниже 256 клампится к 256 (мелкий текст не превращается в кашу)", async () => {
    st.imgSize = { width: 1000, height: 500 };
    await viewFile(files.png, { maxSide: 100 });
    expect(st.resizeCalls).toEqual([{ width: 256, height: 128 }]);
  });

  it("JPEG-исходник после ужатия кодируется в JPEG q80 (не PNG в 3-5 раз тяжелее)", async () => {
    st.imgSize = { width: 4000, height: 3000 };
    const r = await viewFile(files.jpg);
    expect(r.mediaType).toBe("image/jpeg");
    expect(r.image).toBe(Buffer.from("JPEGOUT").toString("base64"));
    expect(st.jpegQ).toBe(80);
  });

  it("decode-bomb: PNG 20000×20000 по заголовку отвергается ДО декодирования", async () => {
    await expect(viewFile(files.pngBomb)).rejects.toThrow(/слишком большая картинка.*20000×20000/u);
    expect(st.resizeCalls).toEqual([]);
  });

  it("размер — из ДЕКОДЕРА, не из заголовка (заголовок 640×480, декодер 800×600 → 800×600)", async () => {
    const r = await viewFile(files.pngHdr);
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
  });

  it("каталог вместо файла → честная ошибка «не файл»", async () => {
    await expect(viewFile(dir)).rejects.toThrow(/не файл/u);
  });
});

describe("viewFile — GIF/WEBP как есть (nativeImage их не декодирует)", () => {
  it("обрезанный GIF (без трейлера) → честная ошибка «повреждён», а не 400 на весь ход", async () => {
    await expect(viewFile(files.gifCut)).rejects.toThrow(/повреждён.*обрезан/u);
  });

  it("GIF шире 8000 px → честная ошибка про лимит модели", async () => {
    await expect(viewFile(files.gifWide)).rejects.toThrow(/8000 px/u);
  });

  it("maxSide меньше стороны GIF → отдаётся как есть, но с note «maxSide не применён»", async () => {
    const r = await viewFile(files.gifSmall, { maxSide: 256 });
    expect(r.note).toMatch(/maxSide=256 не применён/u);
  });

  it("маленький GIF → байты как есть, размеры из заголовка", async () => {
    const r = await viewFile(files.gifSmall);
    expect(r.mediaType).toBe("image/gif");
    expect(r.width).toBe(320);
    expect(r.height).toBe(240);
    expect(r.image).toBe(gifBytes(320, 240, 100).toString("base64"));
    expect(r.resized).toBe(false);
  });

  it("большой GIF → честная ошибка «слишком большой, конвертировать нечем» (не пустая картинка)", async () => {
    await expect(viewFile(files.gifBig)).rejects.toThrow(/слишком большой.*нечем/u);
  });
});

describe("viewFile — PDF через python+PyMuPDF", () => {
  const fakePng = Buffer.from("PDFPAGEPNG");

  it("страница рендерится: page/pageCount/размеры из ответа python, argv несёт путь/страницу/maxSide", async () => {
    st.script = { stdout: `3 1108 1568 0.75\n${fakePng.toString("base64")}`, code: 0 };
    const r = await viewFile(files.pdf, { page: 2, maxSide: 1200 });
    expect(r.format).toBe("pdf");
    expect(r.page).toBe(2);
    expect(r.pageCount).toBe(3);
    expect(r.width).toBe(1108);
    expect(r.height).toBe(1568);
    expect(r.mediaType).toBe("image/png");
    expect(r.image).toBe(fakePng.toString("base64"));
    expect(st.spawnCalls).toHaveLength(1);
    expect(st.spawnCalls[0]!.cmd).toBe("python");
    expect(st.spawnCalls[0]!.args.slice(-3)).toEqual([files.pdf, "2", "1200"]);
    expect(r.resized).toBe(true); // zoom 0.75 < 1 — реально ужата
    expect(r.rendered).toBe(true);
  });

  it("страница МЕНЬШЕ maxSide (zoom ≥ 1, визитка) → resized:false — «ужато» не врёт", async () => {
    st.script = { stdout: `1 360 200 4.0\n${fakePng.toString("base64")}`, code: 0 };
    const r = await viewFile(files.pdf);
    expect(r.resized).toBe(false);
    expect(r.rendered).toBe(true);
  });

  it("PDF под паролем (код 5) → честная причина «защищён паролем», не «0 страниц»", async () => {
    st.script = { stderr: "ENCRYPTED\n", code: 5 };
    await expect(viewFile(files.pdf)).rejects.toThrow(/защищён паролем/u);
  });

  it("PDF без страниц (код 6) → «страниц не обнаружено»", async () => {
    st.script = { stderr: "NOPAGES\n", code: 6 };
    await expect(viewFile(files.pdf)).rejects.toThrow(/страниц не обнаружено/u);
  });

  it("рендер страницы больше капа base64 → переупаковка через nativeImage (PNG из энкодера), не ошибка", async () => {
    st.script = { stdout: `1 1000 1000 1.0\n${"A".repeat(3_600_000)}`, code: 0 };
    const r = await viewFile(files.pdf);
    expect(r.image).toBe(Buffer.from("PNGOUT").toString("base64"));
    expect(r.mediaType).toBe("image/png");
  });

  it("страница вне диапазона → ошибка С ЧИСЛОМ страниц", async () => {
    st.script = { stderr: "RANGE 5\n", code: 4 };
    await expect(viewFile(files.pdf, { page: 9 })).rejects.toThrow(/5 страниц.*страницы 9 нет/u);
  });

  it("python не найден → честная ошибка «отрендерить нечем (python + PyMuPDF)»", async () => {
    st.script = { enoent: true };
    await expect(viewFile(files.pdf)).rejects.toThrow(/отрендерить нечем.*python.*PyMuPDF/u);
  });

  it("python есть, fitz нет (код 3) → честная ошибка про PyMuPDF", async () => {
    st.script = { stderr: "NOFITZ\n", code: 3 };
    await expect(viewFile(files.pdf)).rejects.toThrow(/PyMuPDF/u);
  });

  it("рендер упал (код 1) → ошибка с хвостом stderr, не пустая картинка", async () => {
    st.script = { stderr: "Traceback: FileDataError: cannot open <broken> document", code: 1 };
    const err = await viewFile(files.pdf).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/cannot open broken document/u); // скобки вырезаны, пробелы схлопнуты (M11)
    expect((err as Error).message).not.toContain("<broken>");
    expect((err as Error).message).toMatch(/данные, не инструкции/u);
  });

  it("зависший рендер → таймаут, процесс убит", async () => {
    st.script = { hang: true };
    await expect(renderPdfPage(files.pdf, 1, 1568, 50)).rejects.toThrow(/не уложился/u);
    expect(st.killCalls).toBe(1);
  });

  it("page не целое/меньше 1 → ошибка до спавна", async () => {
    await expect(viewFile(files.pdf, { page: 0 })).rejects.toThrow(/page/u);
    expect(st.spawnCalls).toHaveLength(0);
  });
});

describe("viewFile — честные отказы на не-картинках", () => {
  it(".docx (zip-сигнатура) → ошибка называет office_word", async () => {
    await expect(viewFile(files.docx)).rejects.toThrow(/office_word/u);
  });

  it("BMP → «BMP модель не принимает» + конвертация; .xlsx → office_excel; .pptx → python-pptx; бинарник без сигнатуры → code_run", async () => {
    await expect(viewFile(files.bmp)).rejects.toThrow(/BMP модель не принимает/u);
    await expect(viewFile(files.xlsx)).rejects.toThrow(/office_excel/u);
    await expect(viewFile(files.pptx)).rejects.toThrow(/python-pptx/u);
    await expect(viewFile(files.bin)).rejects.toThrow(/code_run/u);
  });

  it("текстовый файл → ошибка называет fs_read", async () => {
    await expect(viewFile(files.txt)).rejects.toThrow(/fs_read/u);
  });

  it("секретный путь (~/.ssh/id_rsa) → защита секретов срабатывает ДО чтения", async () => {
    await expect(viewFile(join(dir, ".ssh", "id_rsa"))).rejects.toThrow(/защита секретов/u);
  });

  it("файла нет → «файла нет», не абстрактный ENOENT", async () => {
    await expect(viewFile(join(dir, "missing.png"))).rejects.toThrow(/файла нет/u);
  });
});
