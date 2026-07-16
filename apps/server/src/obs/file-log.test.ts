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
      sink.sink({ ts: Date.now(), level: "error", scope: "x", msg: "boom", meta: cyclic });
      sink.flush();
    }).not.toThrow();
    const f = readdirSync(dir).find((n) => n.startsWith("server-"))!;
    // Проверяем именно КОЛЛАПС meta в строку (msg отдельный — иначе ассерт ловил бы совпадение по msg, ревью #1).
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8").trim().split("\n").pop()!);
    expect(typeof rec.meta).toBe("string");
    expect(rec.msg).toBe("boom");
  });

  it("dispose дослаёт буфер и останавливает таймер", () => {
    const sink = new FileLogSink({ dir });
    sink.start();
    sink.sink({ ts: Date.now(), level: "info", scope: "x", msg: "перед выходом" });
    sink.dispose();
    const f = readdirSync(dir).find((n) => n.startsWith("server-"))!;
    expect(readFileSync(join(dir, f), "utf8")).toContain("перед выходом");
  });

  it("крупный meta режется по длине (bounded serialization, ревью 2026-07-15)", () => {
    const sink = new FileLogSink({ dir });
    sink.sink({ ts: Date.now(), level: "info", scope: "x", msg: "big", meta: { blob: "x".repeat(20_000) } });
    sink.flush();
    const f = readdirSync(dir).find((n) => n.startsWith("server-"))!;
    const content = readFileSync(join(dir, f), "utf8");
    expect(content).toContain("срезано]"); // маркер усечения
    const rec = JSON.parse(content.trim().split("\n").pop()!);
    expect(typeof rec.meta).toBe("string"); // крупный meta → усечённая строка (не полный объект)
    expect(rec.meta.length).toBeLessThan(20_000);
  });

  it("небольшой meta остаётся структурным объектом (не режется — для грепа)", () => {
    const sink = new FileLogSink({ dir });
    sink.sink({ ts: Date.now(), level: "info", scope: "x", msg: "small", meta: { a: 1, b: "две" } });
    sink.flush();
    const f = readdirSync(dir).find((n) => n.startsWith("server-"))!;
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8").trim().split("\n").pop()!);
    expect(rec.meta).toEqual({ a: 1, b: "две" });
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
