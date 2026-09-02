/**
 * Честность fs.search/fs.readFile — второй заход (адверс-ревью 2026-09-01): «дерево пройдено ДО КОНЦА»
 * обязано учитывать ВСЕ пропуски (ссылки, нечитаемые/большие/не-UTF-8 файлы), бюджет времени, каталоги
 * по имени, allowlist %VAR%, механика «stat до чтения» — и каждый кейс ДИСКРИМИНИРУЮЩИЙ.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, search } from "./fs.js";
import { DEFAULT_SEARCH_BUDGET_MS, DEFAULT_SEARCH_SCAN_CAP, searchBudgetMs, searchScanCap } from "./fs-search-report.js";
import { sniffContent } from "./fs-content.js";

let root: string;
beforeAll(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "jarvis-fs-honesty2-"));
});
afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});
const mk = async (name: string): Promise<string> => {
  const d = join(root, name);
  await fsp.mkdir(d, { recursive: true });
  return d;
};
const winIt = process.platform === "win32" ? it : it.skip;

describe("fs.search — exhausted:true ТОЛЬКО без единого пропуска", () => {
  it("файл больше 2 МБ по содержимому не сканируется → oversizedFiles=1, exhausted=false, note об этом; и в память он НЕ читается", async () => {
    const dir = await mk("oversized");
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    big.write("needle-big", 100, "utf8");
    await fsp.writeFile(join(dir, "huge.txt"), big);
    await fsp.writeFile(join(dir, "small.txt"), "needle-big тут\n", "utf8");
    const spy = vi.spyOn(fsp, "readFile");
    try {
      const res = await search(dir, "needle-big", true, 50);
      expect(res.matches.map((m) => m.path.endsWith("small.txt"))).toEqual([true]);
      expect(res.oversizedFiles).toBe(1);
      expect(res.exhausted).toBe(false);
      expect(res.note).toMatch(/больше 2 МБ/u);
      // механика «stat ДО чтения»: huge.txt не должен побывать в readFile
      expect(spy.mock.calls.some((c) => String(c[0]).endsWith("huge.txt"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  winIt("нечитаемый файл (реальный deny на чтение) → unreadableFiles=1, exhausted=false, note «не удалось прочитать»", async () => {
    const dir = await mk("unreadable-file");
    const locked = join(dir, "locked.txt");
    await fsp.writeFile(locked, "needle-locked\n", "utf8");
    await fsp.writeFile(join(dir, "open.txt"), "ничего\n", "utf8");
    const user = process.env.USERNAME ?? "";
    execFileSync("icacls", [locked, "/deny", `${user}:(R)`], { stdio: "ignore" });
    try {
      const res = await search(dir, "needle-locked", true, 50);
      expect(res.matches).toHaveLength(0);
      expect(res.unreadableFiles).toBe(1);
      expect(res.exhausted).toBe(false);
      expect(res.note).toMatch(/не удалось прочитать/u);
    } finally {
      execFileSync("icacls", [locked, "/remove:d", user], { stdio: "ignore" });
    }
  });

  winIt("junction внутри дерева НЕ проходится, но считается: skippedLinks=1, exhausted=false, note про junction", async () => {
    const dir = await mk("links");
    const real = await mk("links-real");
    await fsp.writeFile(join(real, "target-file.txt"), "needle here\n", "utf8");
    await fsp.symlink(real, join(dir, "linked"), "junction");
    const byName = await search(dir, "target-file");
    expect(byName.matches).toHaveLength(0);
    expect(byName.skippedLinks).toBe(1);
    expect(byName.exhausted).toBe(false);
    expect(byName.note).toMatch(/junction/u);
  });

  it("cp1251-файл → прочитан как cp1251 по эвристике: кириллическая иголка НАХОДИТСЯ, recodedFiles=1, note про эвристику, exhausted=true", async () => {
    const dir = await mk("cp1251");
    // «договор» в cp1251 + ASCII-хвост
    const cp = Buffer.from([0xe4, 0xee, 0xe3, 0xee, 0xe2, 0xee, 0xf0, 0x20, 0x41, 0x53, 0x43, 0x49, 0x49, 0x0a]);
    await fsp.writeFile(join(dir, "old.txt"), cp);
    const cyr = await search(dir, "договор", true, 50);
    expect(cyr.matches).toHaveLength(1);
    expect(cyr.matches[0]!.preview).toContain("договор");
    expect(cyr.recodedFiles).toBe(1);
    expect(cyr.undecodedFiles).toBe(0);
    expect(cyr.exhausted).toBe(true);
    expect(cyr.note).toMatch(/cp1251 по эвристике/u);
  });

  it("не-UTF-8 и не cp1251 (Latin-1) → undecodedFiles=1, exhausted=false, note «не похожи на cp1251»", async () => {
    const dir = await mk("latin1");
    await fsp.writeFile(join(dir, "fr.txt"), Buffer.from("caf\xe9 r\xe9sum\xe9 na\xefve needle-fr\n", "latin1"));
    const res = await search(dir, "needle-fr", true, 50);
    expect(res.matches).toHaveLength(1);
    expect(res.undecodedFiles).toBe(1);
    expect(res.recodedFiles).toBe(0);
    expect(res.exhausted).toBe(false);
    expect(res.note).toMatch(/не похожи на cp1251/u);
  });

  it("бюджет времени: budgetMs=0 → stopReason=time_budget, exhausted=false, note «бюджету времени»", async () => {
    const dir = await mk("budget");
    await fsp.writeFile(join(dir, "a.txt"), "x", "utf8");
    const res = await search(dir, "a", false, 50, { budgetMs: 0 });
    expect(res.stopReason).toBe("time_budget");
    expect(res.exhausted).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.note).toMatch(/бюджету времени/u);
  });

  it('каталог совпадает ПО ИМЕНИ (kind:"dir") — «где папка X» больше не даёт «папки нет»', async () => {
    const dir = await mk("dirmatch");
    await fsp.mkdir(join(dir, "reports-needle"), { recursive: true });
    await fsp.writeFile(join(dir, "reports-needle", "inner.txt"), "x", "utf8");
    const res = await search(dir, "needle");
    expect(res.matches.some((m) => m.kind === "dir" && m.path.endsWith("reports-needle"))).toBe(true);
    expect(res.exhausted).toBe(true);
  });

  it("чистое дерево → все счётчики нули, exhausted=true, note нет (регресс)", async () => {
    const dir = await mk("clean");
    await fsp.writeFile(join(dir, "a.txt"), "иголка\n", "utf8");
    const res = await search(dir, "иголка", true, 50);
    expect(res.matches).toHaveLength(1);
    expect(res).toMatchObject({ exhausted: true, skippedDirs: 0, skippedLinks: 0, unreadableFiles: 0, oversizedFiles: 0, undecodedFiles: 0, recodedFiles: 0 });
    expect(res.note).toBeUndefined();
  });

  it("%VAR% не из allowlist: значение переменной НЕ утекает в текст ошибки поиска", async () => {
    process.env.JARVIS_TEST_SECRET2 = "sk-ant-LEAK";
    const err = await search("%JARVIS_TEST_SECRET2%\\nope", "x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/не существует/u);
    expect((err as Error).message).not.toContain("sk-ant-LEAK");
  });
});

describe("fs-search-report — кап и бюджет из env читаются лениво и клампятся", () => {
  const saved = { cap: process.env.JARVIS_FS_SEARCH_SCAN_CAP, budget: process.env.JARVIS_FS_SEARCH_BUDGET_MS };
  afterEach(() => {
    if (saved.cap === undefined) delete process.env.JARVIS_FS_SEARCH_SCAN_CAP;
    else process.env.JARVIS_FS_SEARCH_SCAN_CAP = saved.cap;
    if (saved.budget === undefined) delete process.env.JARVIS_FS_SEARCH_BUDGET_MS;
    else process.env.JARVIS_FS_SEARCH_BUDGET_MS = saved.budget;
  });
  it("scanCap: env=7 → 7; мусор/0/-1 → дефолт; opts главнее env", () => {
    process.env.JARVIS_FS_SEARCH_SCAN_CAP = "7";
    expect(searchScanCap()).toBe(7);
    expect(searchScanCap({ scanCap: 3 })).toBe(3);
    for (const bad of ["abc", "0", "-1"]) {
      process.env.JARVIS_FS_SEARCH_SCAN_CAP = bad;
      expect(searchScanCap()).toBe(DEFAULT_SEARCH_SCAN_CAP);
    }
  });
  it("budgetMs: env=5000 → 5000; env<1000 → дефолт (0 в env — не «без поиска»); opts допускает 0", () => {
    process.env.JARVIS_FS_SEARCH_BUDGET_MS = "5000";
    expect(searchBudgetMs()).toBe(5000);
    process.env.JARVIS_FS_SEARCH_BUDGET_MS = "0";
    expect(searchBudgetMs()).toBe(DEFAULT_SEARCH_BUDGET_MS);
    expect(searchBudgetMs({ budgetMs: 0 })).toBe(0);
  });
});

describe("fs.readFile / sniffContent — UTF-16 честно, подсказки ведут в рабочий инструмент", () => {
  it("FF FE + бинарное содержимое → БИНАРНИК (не «utf16le»-мусор без ошибки)", async () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(20, 0), Buffer.from([0x01, 0x02, 0x03, 0x89, 0x50])]);
    expect(sniffContent(buf, ".bin").kind).toBe("binary");
    const p = join(root, "fake-utf16.bin");
    await fsp.writeFile(p, buf);
    await expect(readFile(p)).rejects.toThrow(/бинарный файл/u);
  });
  it("настоящий UTF-16LE текст с BOM — по-прежнему текст", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("привет мир\n", "utf16le")]);
    expect(sniffContent(buf, ".txt")).toMatchObject({ kind: "text", encoding: "utf16le" });
  });
  it("UTF-16 нечётной длины → note про отброшенный байт (truncated:false не врёт «прочитано всё»)", async () => {
    const p = join(root, "odd.txt");
    await fsp.writeFile(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ab", "utf16le"), Buffer.from([0x41])]));
    const r = await readFile(p);
    expect(r.content).toBe("ab");
    expect(r.truncated).toBe(false);
    expect(r.note).toMatch(/нечётная длина UTF-16/u);
  });
  it("картинка, которую file_view не показывает (.tif) → подсказка ведёт в конвертацию, а не в file_view; PNG — в file_view", async () => {
    const tif = join(root, "scan.tif");
    await fsp.writeFile(tif, Buffer.concat([Buffer.from("II*\0", "latin1"), Buffer.alloc(64, 0)]));
    const e1 = await readFile(tif).catch((e: Error) => e);
    expect((e1 as Error).message).toMatch(/сконвертируй в PNG/u);
    expect((e1 as Error).message).not.toMatch(/Посмотреть картинку — file_view/u);
    const png = join(root, "ok.png");
    await fsp.writeFile(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0)]));
    await expect(readFile(png)).rejects.toThrow(/Посмотреть картинку — file_view/u);
  });
});
