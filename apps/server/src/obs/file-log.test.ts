import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLogSink, pruneOldLogs } from "./file-log.js";

describe("FileLogSink — durable файловый лог (аудит 2026-07-02)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-filelog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("флаш пишет JSONL-строки в server-YYYY-MM-DD.log", () => {
    const sink = new FileLogSink({ dir });
    sink.sink({ ts: Date.now(), level: "info", scope: "test", msg: "привет", meta: { a: 1 } });
    sink.sink({ ts: Date.now(), level: "warn", scope: "test", msg: "ой" });
    sink.flush();
    const files = readdirSync(dir).filter((f) => f.startsWith("server-"));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ level: "info", scope: "test", msg: "привет", meta: { a: 1 } });
    expect(typeof first.ts).toBe("string");
  });

  it("несериализуемый meta (цикл) не роняет sink — стягивается в строку", () => {
    const sink = new FileLogSink({ dir });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => {
      sink.sink({ ts: Date.now(), level: "error", scope: "x", msg: "cyclic", meta: cyclic });
      sink.flush();
    }).not.toThrow();
    const f = readdirSync(dir).find((n) => n.startsWith("server-"))!;
    expect(readFileSync(join(dir, f), "utf8")).toContain("cyclic");
  });

  it("dispose дослаёт буфер и останавливает таймер", () => {
    const sink = new FileLogSink({ dir });
    sink.start();
    sink.sink({ ts: Date.now(), level: "info", scope: "x", msg: "перед выходом" });
    sink.dispose();
    const f = readdirSync(dir).find((n) => n.startsWith("server-"))!;
    expect(readFileSync(join(dir, f), "utf8")).toContain("перед выходом");
  });

  it("pruneOldLogs удаляет server-логи старше retention, свежие оставляет", () => {
    const now = new Date(2026, 6, 2); // 2026-07-02 (локальная)
    writeFileSync(join(dir, "server-2026-06-01.log"), "old\n"); // 31 день назад
    writeFileSync(join(dir, "server-2026-07-01.log"), "fresh\n"); // вчера
    writeFileSync(join(dir, "metrics.jsonl"), "keep\n"); // не server-* — не трогаем
    pruneOldLogs(dir, 7, now);
    expect(existsSync(join(dir, "server-2026-06-01.log"))).toBe(false);
    expect(existsSync(join(dir, "server-2026-07-01.log"))).toBe(true);
    expect(existsSync(join(dir, "metrics.jsonl"))).toBe(true);
  });
});
