/**
 * 🔴 АНТИ-ИНЪЕКЦИЯ В OFFICE-COM — ПОВЕДЕНЧЕСКИ (аудит тестовой базы 2026-09-01).
 *
 * Прежняя проверка выглядела как гард, но им не была: `expect(EXCEL_SCRIPT).not.toContain("Remove-Item")`
 * смотрит на СТАТИЧЕСКУЮ константу, которая от входных данных не зависит вовсе. То есть реализация,
 * склеивающая данные пользователя прямо в тело PowerShell-скрипта, прошла бы этот тест не поперхнувшись —
 * а это и есть та самая инъекция, ради защиты от которой заведён temp-JSON.
 *
 * Здесь проверяется НАБЛЮДАЕМОЕ: что именно ушло в powershell. Данные обязаны попасть в файл, на
 * который указывает переменная окружения, а тело скрипта должно остаться неизменной константой.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined>; argsFile: string }> = [];

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  return {
    spawn: (_cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
      const argsPath = String(opts.env.JARVIS_OFFICE_ARGS ?? "");
      // Содержимое temp-файла читаем СРАЗУ: после завершения вызова office.ts его удаляет.
      let fileBody = "";
      try {
        fileBody = readFileSync(argsPath, "utf8");
      } catch {
        fileBody = "";
      }
      spawnCalls.push({ args, env: opts.env, argsFile: fileBody });

      const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        stdout: InstanceType<typeof EventEmitter> & { setEncoding: (e: string) => void };
        stderr: InstanceType<typeof EventEmitter>;
        pid: number;
        kill: () => void;
      };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.stderr = new EventEmitter();
      child.pid = 4242;
      child.kill = () => undefined;
      setImmediate(() => {
        child.stdout.emit("data", `JARVIS_OFFICE_RESULT ${JSON.stringify({ ok: true })}\n`);
        child.emit("close", 0);
      });
      return child;
    },
    execFile: (_c: string, _a: string[], _o: unknown, cb?: (e: null) => void) => cb?.(null),
  };
});

const { EXCEL_SCRIPT, WORD_SCRIPT, runExcel, runWord } = await import("./office.js");

/** Полезная нагрузка, которая при склейке в скрипт стала бы исполняемой командой PowerShell. */
const PAYLOAD = `"; Remove-Item C:\Windows -Recurse -Force; Write-Output "`;

let dir = "";
beforeEach(() => {
  spawnCalls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "jarvis-office-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("данные пользователя не попадают в тело PowerShell-скрипта", () => {
  it("Excel: вредоносное значение ячейки уходит в JSON-файл, скрипт — неизменная константа", async () => {
    await runExcel({ kind: "office.excel", op: "write_cell", path: join(dir, "книга.xlsx"), sheet: PAYLOAD, cell: "A1", value: PAYLOAD });

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    const script = call.args[call.args.length - 1] ?? "";

    expect(script).toBe(EXCEL_SCRIPT); // тело — ровно константа, без подстановок
    expect(script).not.toContain("Remove-Item C:"); // ← корень: данные не склеены в команду
    expect(script).not.toContain(PAYLOAD);
    expect(call.env.JARVIS_OFFICE_ARGS).toBeTruthy(); // путь к данным передан окружением
    expect(call.argsFile).toContain("Remove-Item"); // а сами данные лежат в JSON-файле
    expect(JSON.parse(call.argsFile).value).toBe(PAYLOAD); // и доезжают без искажения
  });

  it("Word: то же самое для текста документа", async () => {
    await runWord({ kind: "office.word", op: "write", path: join(dir, "письмо.docx"), text: PAYLOAD });

    const call = spawnCalls[0]!;
    const script = call.args[call.args.length - 1] ?? "";
    expect(script).toBe(WORD_SCRIPT);
    expect(script).not.toContain(PAYLOAD);
    expect(JSON.parse(call.argsFile).text).toBe(PAYLOAD);
  });

  it("путь к файлу тоже не склеивается в скрипт", async () => {
    const nasty = join(dir, `отчёт'; Remove-Item .; '.xlsx`);
    await runExcel({ kind: "office.excel", op: "write_cell", path: nasty, cell: "A1", value: "1" });

    const call = spawnCalls[0]!;
    const script = call.args[call.args.length - 1] ?? "";
    expect(script).not.toContain("Remove-Item .");
    expect(JSON.parse(call.argsFile).path).toContain("Remove-Item ."); // путь ушёл данными
  });
});
