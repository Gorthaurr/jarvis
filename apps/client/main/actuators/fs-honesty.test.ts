/**
 * Честность fs_search / fs_read (CAPABILITY_GAPS 2026-09-01 §3.3 и §3.9(б)).
 *
 * §3.3: на рабочем столе владельца 588 213 файлов, кап 20 000 покрывает 3,4% дерева, а
 * `{matches:[], truncated:true}` модель читала как «не нашёл». Теперь исходы разведены:
 * `stopReason` (max_results | scan_cap), `scannedFiles`, `exhausted`, `skippedDirs`, `note`.
 * §3.9(б): fs_read на PDF/PNG/docx отдавал utf8-мусор БЕЗ ошибки — теперь честная ошибка с классом
 * файла и каналом чтения; UTF-16 с BOM — текст, декодируется.
 *
 * Все тесты дискриминирующие (реверт-проверки — в отчёте сессии).
 */
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, search } from "./fs.js";

let root: string;
const mk = async (name: string): Promise<string> => {
  const dir = join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "jarvis-fs-honesty-"));
});
afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("fs.search — truncated разведён на исходы (§3.3)", () => {
  it("(а) кап просмотренных файлов → stopReason=scan_cap, exhausted=false, scannedFiles=кап, note «НЕ досмотрено»", async () => {
    const dir = await mk("scan-cap");
    await Promise.all(Array.from({ length: 30 }, (_, i) => fsp.writeFile(join(dir, `f${i}.txt`), "x", "utf8")));
    const res = await search(dir, "нет-такого-имени", false, 50, { scanCap: 10 });
    expect(res.stopReason).toBe("scan_cap");
    expect(res.exhausted).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.scannedFiles).toBe(10);
    expect(res.matches).toHaveLength(0);
    expect(res.note).toContain("НЕ досмотрено");
    expect(res.note).toContain("10"); // кап назван числом
    expect(res.note).toContain("app_channels"); // куда идти вместо обхода
  });

  it("(б) maxResults=2 при 5 совпадениях → stopReason=max_results, exhausted=false, показаны первые", async () => {
    const dir = await mk("max-results");
    await Promise.all(Array.from({ length: 5 }, (_, i) => fsp.writeFile(join(dir, `report-${i}.txt`), "x", "utf8")));
    const res = await search(dir, "report", false, 2);
    expect(res.stopReason).toBe("max_results");
    expect(res.exhausted).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.matches).toHaveLength(2);
    expect(res.note).toContain("maxResults=2");
    expect(res.note).not.toContain("НЕ досмотрено"); // это НЕ кап дерева
  });

  it("(в) маленькое дерево целиком → exhausted=true, без stopReason и note", async () => {
    const dir = await mk("exhausted");
    await fsp.mkdir(join(dir, "sub"));
    await fsp.writeFile(join(dir, "a.txt"), "1", "utf8");
    await fsp.writeFile(join(dir, "sub", "b.txt"), "2", "utf8");
    const res = await search(dir, "нет-такого", false, 50);
    expect(res.exhausted).toBe(true);
    expect(res.stopReason).toBeUndefined();
    expect(res.note).toBeUndefined();
    expect(res.truncated).toBe(false);
    expect(res.skippedDirs).toBe(0);
    expect(res.scannedFiles).toBe(2);
  });

  // Реальный сисколл, не spy: `icacls /deny (RD)` отбирает у текущего пользователя право листинга —
  // `readdir` даёт EPERM (проверено на этой машине). Snap-back в finally, иначе temp не почистится.
  const winIt = process.platform === "win32" ? it : it.skip;
  winIt("(г) недоступный подкаталог → skippedDirs>0, exhausted=false, note про недоступные каталоги", async () => {
    const dir = await mk("skipped");
    const locked = join(dir, "locked");
    await fsp.mkdir(locked);
    await fsp.writeFile(join(locked, "hidden-report.txt"), "x", "utf8");
    await fsp.writeFile(join(dir, "open-report.txt"), "x", "utf8");
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync("icacls", [locked, "/deny", `${user}:(RD)`], { stdio: "ignore" });
    try {
      const res = await search(dir, "report", false, 50);
      expect(res.skippedDirs).toBe(1);
      expect(res.exhausted).toBe(false);
      expect(res.stopReason).toBeUndefined(); // капы не срабатывали — неполнота ТОЛЬКО из-за прав
      expect(res.matches).toHaveLength(1);
      expect(res.matches[0]!.path.endsWith("open-report.txt")).toBe(true);
      expect(res.note).toMatch(/1 каталог не удалось прочитать/);
    } finally {
      execFileSync("icacls", [locked, "/remove:d", user], { stdio: "ignore" });
    }
  });

  it("корень не существует → ошибка, а не «файлов нет»", async () => {
    await expect(search(join(root, "no-such-root"), "x")).rejects.toThrow(/не существует/);
  });

  it("корень — файл, а не каталог → ошибка называет причину", async () => {
    const p = join(root, "root-is-file.txt");
    await fsp.writeFile(p, "x", "utf8");
    await expect(search(p, "x")).rejects.toThrow(/не каталог/);
  });

  it("поиск по содержимому: бинарник с той же строкой внутри НЕ матчится, UTF-16-текст — матчится", async () => {
    const dir = await mk("content-binary");
    // PNG-сигнатура + ASCII-строка с иголкой внутри — раньше сканировался как utf8-мусор и «находился».
    await fsp.writeFile(join(dir, "pic.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("needle-inside\n")]));
    await fsp.writeFile(join(dir, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("строка с needle-inside", "utf16le")]));
    const res = await search(dir, "needle-inside", true, 50);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]!.path.endsWith("u16.txt")).toBe(true);
    expect(res.matches[0]?.preview).toContain("строка с needle-inside");
    expect(res.scannedFiles).toBe(2); // бинарник просмотрен (и отвергнут), не «пропущен» молча
  });

  it("поиск по содержимому: файл больше 2 МБ не сканируется (механика «stat до чтения» — в fs-honesty-2)", async () => {
    const dir = await mk("content-huge");
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61); // 'a' × (2 МБ + 1)
    big.write("needle-huge", 100, "utf8");
    await fsp.writeFile(join(dir, "huge.txt"), big);
    await fsp.writeFile(join(dir, "small.txt"), "needle-huge тут\n", "utf8");
    const res = await search(dir, "needle-huge", true, 50);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]!.path.endsWith("small.txt")).toBe(true);
  });
});

describe("fs.readFile — бинарник даёт честную ошибку, UTF-16 читается (§3.9(б))", () => {
  const file = async (name: string, data: Buffer | string): Promise<string> => {
    const p = join(root, name);
    await fsp.writeFile(p, data);
    return p;
  };

  it("PDF-сигнатура → ошибка с классом «PDF» и путём к pdftotext/file_view", async () => {
    const p = await file("doc.pdf", "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"); // чистый ASCII — только сигнатура его выдаёт
    await expect(readFile(p)).rejects.toThrow(/бинарный файл \(PDF-документ\)/);
    await expect(readFile(p)).rejects.toThrow(/doc\.pdf/);
    await expect(readFile(p)).rejects.toThrow(/pdftotext/);
    await expect(readFile(p)).rejects.toThrow(/file_view/);
  });

  it("PNG-байты → ошибка «PNG-изображение», file_view", async () => {
    const p = await file("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
    await expect(readFile(p)).rejects.toThrow(/PNG-изображение/);
    await expect(readFile(p)).rejects.toThrow(/file_view/);
  });

  it("zip-байты с расширением .docx → ошибка, называющая docx и office_word", async () => {
    const p = await file("letter.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]));
    await expect(readFile(p)).rejects.toThrow(/docx/);
    await expect(readFile(p)).rejects.toThrow(/office_word/);
  });

  it("бинарник без сигнатуры (NUL-байты) → ошибка по содержимому с расширением", async () => {
    const p = await file("blob.bin", Buffer.from([0x01, 0x02, 0x00, 0x41, 0x42, 0x00, 0xfe]));
    await expect(readFile(p)).rejects.toThrow(/бинарный файл \(расширение \.bin/);
  });

  it("MZ-заголовок с NUL → ошибка «исполняемый файл EXE/DLL»", async () => {
    const p = await file("tool.exe", Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(64)]));
    await expect(readFile(p)).rejects.toThrow(/EXE\/DLL/);
  });

  it("текст, начинающийся с «MZ», — НЕ бинарник (слабая сигнатура без эвристики не решает)", async () => {
    const p = await file("mz-notes.txt", "MZ-серия: заметки про модели\n");
    expect((await readFile(p)).content).toBe("MZ-серия: заметки про модели\n");
  });

  it("UTF-16LE с BOM → content декодирован, encoding=utf16le, без ошибки", async () => {
    const p = await file("u16le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("привет, мир", "utf16le")]));
    const r = await readFile(p);
    expect(r.content).toBe("привет, мир");
    expect(r.encoding).toBe("utf16le");
    expect(r.bytes).toBe(2 + "привет, мир".length * 2);
  });

  it("UTF-16BE с BOM → content декодирован, encoding=utf16be", async () => {
    const le = Buffer.from("текст BE", "utf16le");
    const be = Buffer.from(le).swap16();
    const p = await file("u16be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    const r = await readFile(p);
    expect(r.content).toBe("текст BE");
    expect(r.encoding).toBe("utf16be");
  });

  // Дискриминирует именно BE: LE-декодер Node молча отбрасывает хвостовой нечётный байт, а swap16 на
  // нечётной длине БРОСАЕТ RangeError — без выравнивания usecase «maxBytes на UTF-16BE» падал бы.
  it("maxBytes на UTF-16 не режет код-юнит пополам (LE и BE)", async () => {
    const le = await file("u16cut-le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("абв", "utf16le")]));
    const rle = await readFile(le, 5); // BOM(2) + 3 байта → берём только 2 (один символ), не половину «б»
    expect(rle.content).toBe("а");
    expect(rle.truncated).toBe(true);
    const be = await file("u16cut-be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from("абв", "utf16le")).swap16()]));
    const rbe = await readFile(be, 5);
    expect(rbe.content).toBe("а");
    expect(rbe.truncated).toBe(true);
  });

  it("UTF-8 с BOM → BOM срезан, encoding=utf8-bom", async () => {
    const p = await file("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("данные", "utf8")]));
    const r = await readFile(p);
    expect(r.content).toBe("данные");
    expect(r.encoding).toBe("utf8-bom");
  });

  it("обычный UTF-8 (кириллица) — как раньше, encoding=utf8, без note", async () => {
    const p = await file("plain.txt", "квартальная выручка\n");
    const r = await readFile(p);
    expect(r.content).toBe("квартальная выручка\n");
    expect(r.encoding).toBe("utf8");
    expect(r.note).toBeUndefined();
  });

  it("не-UTF-8 текст (cp1251) → декодирован как cp1251 по эвристике, encoding=cp1251, честная note об эвристике", async () => {
    const p = await file("cp1251.txt", Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a])); // «Привет» в cp1251
    const r = await readFile(p);
    expect(r.content).toContain("Привет");
    expect(r.encoding).toBe("cp1251");
    expect(r.note).toMatch(/cp1251/);
  });

  it("байты не UTF-8 и НЕ похожие на cp1251 (Latin-1 «café résumé») → остаётся UTF-8 с «�» и note про кодировку", async () => {
    const p = await file("latin1.txt", Buffer.from("caf\xe9 r\xe9sum\xe9 na\xefve\n", "latin1"));
    const r = await readFile(p);
    expect(r.encoding).toBe("utf8");
    expect(r.content).toContain("�");
    expect(r.note).toMatch(/UTF-8/);
  });

  it("пустой файл → \"\" и bytes:0, НЕ ошибка", async () => {
    const p = await file("empty.txt", "");
    const r = await readFile(p);
    expect(r.content).toBe("");
    expect(r.bytes).toBe(0);
    expect(r.truncated).toBe(false);
  });
});
