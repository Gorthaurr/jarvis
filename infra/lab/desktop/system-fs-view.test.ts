import { describe, expect, it } from "vitest";
import { makeKit } from "./system-test-kit.js";

/** Минимальный корректный PNG w×h: сигнатура + IHDR + IEND (пиксели не нужны — fs.view смотрит заголовок). */
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.alloc(4)]);
}

describe("fs.view", () => {
  it("PNG отдаётся base64 с размерами из заголовка; слишком большая по стороне — отдана как есть с честным note", async () => {
    const k = makeKit();
    k.put("C:/v/ok.png", png(640, 480));
    k.put("C:/v/wide.png", png(4000, 100));
    const ok = await k.data<{ image: string; mediaType: string; width: number; height: number; format: string; resized: boolean; note?: string }>({ kind: "fs.view", path: "C:\\v\\ok.png" });
    expect(ok).toMatchObject({ mediaType: "image/png", width: 640, height: 480, format: "png", resized: false });
    expect(Buffer.from(ok.image, "base64").equals(k.file("C:/v/ok.png")!)).toBe(true);
    expect(ok.note).toBeUndefined();
    const wide = await k.data<{ resized: boolean; note: string }>({ kind: "fs.view", path: "C:\\v\\wide.png", maxSide: 800 });
    expect(wide.resized).toBe(false);
    expect(wide.note).toContain("maxSide=800");
  });

  it("честные отказы: нет файла, каталог, усечённый PNG, текст, PDF (рендер недоступен), .env", async () => {
    const k = makeKit();
    k.put("C:/v/cut.png", png(10, 10).subarray(0, 30));
    k.put("C:/v/note.txt", "текст");
    k.put("C:/v/doc.pdf", Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n", "latin1"));
    k.put("C:/v/.env", "A=1");
    expect(await k.err({ kind: "fs.view", path: "C:/v/нет.png" })).toBe("не удалось прочитать «C:\\v\\нет.png»: файла нет");
    expect(await k.err({ kind: "fs.view", path: "C:/v" })).toContain("не файл");
    expect(await k.err({ kind: "fs.view", path: "C:/v/cut.png" })).toContain("не декодировалось");
    expect(await k.err({ kind: "fs.view", path: "C:/v/note.txt" })).toContain("Это текст — читай fs_read");
    expect(await k.err({ kind: "fs.view", path: "C:/v/doc.pdf" })).toContain("рендер страницы в лаборатории недоступен");
    expect(await k.err({ kind: "fs.view", path: "C:/v/.env" })).toContain("защита секретов");
  });
});
