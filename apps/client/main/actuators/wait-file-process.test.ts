/**
 * wait_for{kind:"file"|"process"} (сценарии 2026-09-02, CAPABILITY_GAPS 3.14) — на реальной ФС и реальных процессах.
 * Главная честность: «файл появился» ≠ «файл дописан» — stableMs требует неизменности размера/mtime.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFile, checkProcess, resetFileWait, validateFileCond, validateProcessCond } from "./wait-file-process.js";

let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "jarvis-waitfile-"));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("checkFile", () => {
  it("нет файла → не выполнено; gone:true → выполнено", async () => {
    const p = join(dir, "missing.bin");
    expect((await checkFile({ kind: "file", path: p }))[0]).toBe(false);
    expect((await checkFile({ kind: "file", path: p, gone: true }))[0]).toBe(true);
  });

  it("пустой файл при minBytes по умолчанию (1) — не выполнено; с содержимым — выполнено", async () => {
    const p = join(dir, "out.txt");
    await fsp.writeFile(p, "");
    expect((await checkFile({ kind: "file", path: p }))[0]).toBe(false);
    await fsp.writeFile(p, "data");
    expect((await checkFile({ kind: "file", path: p }))[0]).toBe(true);
    expect((await checkFile({ kind: "file", path: p, minBytes: 100 }))[0]).toBe(false);
  });

  it("stableMs: растущий файл НЕ готов; стабилен заданное время → готов (время подставляем явно)", async () => {
    const p = join(dir, "render.mp4");
    const cond = { kind: "file" as const, path: p, stableMs: 1000 };
    resetFileWait(cond);
    await fsp.writeFile(p, "aaaa");
    expect((await checkFile(cond, 1_000))[0]).toBe(false); // первый взгляд — точка отсчёта
    await fsp.appendFile(p, "bbbb"); // файл дописывается
    expect((await checkFile(cond, 1_500))[0]).toBe(false); // размер изменился — отсчёт заново
    expect((await checkFile(cond, 2_000))[0]).toBe(false); // 500 мс из 1000
    const [met, detail] = await checkFile(cond, 2_600); // 1100 мс без изменений
    expect(met).toBe(true);
    expect(detail).toMatch(/не меняется/u);
  });

  it("секретный путь отвергается ДО ожидания", () => {
    expect(() => validateFileCond({ kind: "file", path: join(dir, ".ssh", "id_rsa") })).toThrow(/защита секретов/u);
    expect(() => validateFileCond({ kind: "file", path: "" })).toThrow(/пустой path/u);
  });
});

describe("checkProcess", () => {
  it("свой pid жив; gone:true для него — не выполнено", async () => {
    expect((await checkProcess({ kind: "process", pid: process.pid }))[0]).toBe(true);
    expect((await checkProcess({ kind: "process", pid: process.pid, gone: true }))[0]).toBe(false);
  });

  it("завершившийся дочерний процесс: gone:true → выполнено", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { windowsHide: true, stdio: "ignore" });
    const pid = child.pid!;
    await new Promise<void>((r) => child.on("close", () => r()));
    expect((await checkProcess({ kind: "process", pid, gone: true }))[0]).toBe(true);
  });

  it("валидация: ни pid, ни name → ошибка", () => {
    expect(() => validateProcessCond({ kind: "process" })).toThrow(/pid/u);
  });
});
