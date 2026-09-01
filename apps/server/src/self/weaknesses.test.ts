// Самодиагностика по собственной телеметрии (волна I, 2026-08-31).
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWeaknesses, normalizeLogMessage, weaknessesFromLogs, weaknessesFromMetrics } from "./weaknesses.js";

describe("weaknessesFromMetrics", () => {
  it("повторяющаяся деградация становится слабостью, единичная — нет", () => {
    const { weaknesses } = weaknessesFromMetrics([
      { type: "degradation", kind: "web_search_empty", query: "погода" },
      { type: "degradation", kind: "web_search_empty", query: "курс" },
      { type: "degradation", kind: "mail_unreadable" }, // одиночная — шум, не слабость
    ]);
    expect(weaknesses.map((w) => w.kind)).toEqual(["degradation:web_search_empty"]);
    expect(weaknesses[0]?.count).toBe(2);
    expect(weaknesses[0]?.samples).toContain("погода");
  });

  it("считает задачи и находит высокую долю провалов", () => {
    const events = [
      ...Array.from({ length: 6 }, () => ({ ok: true, rounds: 2 })),
      ...Array.from({ length: 4 }, () => ({ ok: false, rounds: 3, failKind: "task" })),
    ];
    const { tasks, weaknesses } = weaknessesFromMetrics(events);
    expect(tasks).toEqual({ total: 10, failed: 4, llmUnavailable: 0 });
    expect(weaknesses.some((w) => w.kind === "task_failures")).toBe(true);
  });

  it("редкие провалы слабостью не объявляются (иначе тревога на пустом месте)", () => {
    const events = [...Array.from({ length: 20 }, () => ({ ok: true, rounds: 1 })), { ok: false, rounds: 1 }];
    expect(weaknessesFromMetrics(events).weaknesses.some((w) => w.kind === "task_failures")).toBe(false);
  });

  it("строки здоровья процесса задачами не считаются", () => {
    expect(weaknessesFromMetrics([{ type: "process_health", rssMb: 200 }]).tasks.total).toBe(0);
  });
});

describe("weaknessesFromLogs", () => {
  it("схлопывает однотипные WARN по нормализованному тексту", () => {
    const entries = [
      { level: "warn", msg: "ActionCommand timeout 90000ms", meta: { kind: "telegram.send" } },
      { level: "warn", msg: "ActionCommand timeout 15000ms" },
      { level: "warn", msg: "ActionCommand timeout 42ms" },
      { level: "info", msg: "ActionCommand timeout 42ms" }, // info — не слабость
    ];
    const w = weaknessesFromLogs(entries);
    expect(w).toHaveLength(1);
    expect(w[0]?.count).toBe(3);
    expect(w[0]?.title).toMatch(/Предупреждение/);
  });

  it("нормализация схлопывает числа и идентификаторы", () => {
    expect(normalizeLogMessage("задача 42 упала (id a1b2c3d4e5f6)")).toBe(normalizeLogMessage("задача 7 упала (id ffffffffffff)"));
  });
});

describe("collectWeaknesses — «не знаю» ≠ «всё хорошо»", () => {
  it("нет каталога логов → честное unavailable", async () => {
    const r = await collectWeaknesses(join(tmpdir(), `нет-такого-${Date.now()}`));
    expect(r.unavailable).toBeTruthy();
    expect(r.weaknesses).toEqual([]);
  });

  it("пустые логи → unavailable, а не «слабостей нет»", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-logs-"));
    const r = await collectWeaknesses(dir);
    expect(r.unavailable).toMatch(/пуста/);
  });

  it("реальные файлы: сводит метрики и логи в один ранжированный список", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-logs-"));
    writeFileSync(
      join(dir, "metrics.jsonl"),
      [
        JSON.stringify({ type: "degradation", kind: "context_masked" }),
        JSON.stringify({ type: "degradation", kind: "context_masked" }),
        JSON.stringify({ type: "degradation", kind: "context_masked" }),
        JSON.stringify({ ok: false, rounds: 4 }),
        "битая строка — не должна ронять разбор",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "server-2026-08-30.log"),
      Array.from({ length: 3 }, () => JSON.stringify({ level: "error", msg: "LLM-вызов не удался — стаб" })).join("\n"),
      "utf8",
    );

    const r = await collectWeaknesses(dir, { days: 7 });
    expect(r.unavailable).toBeUndefined();
    expect(r.windowDays).toBe(1);
    expect(r.weaknesses[0]?.kind).toBe("degradation:context_masked"); // самая частая — первой
    expect(r.weaknesses.some((w) => w.kind.startsWith("error:"))).toBe(true);
  });
});

// 🔴 Разбор боевой телеметрии 2026-08-31: 31 «провал» из 86 — ходы, не дошедшие до модели (кончился
// ключ, протухла подписка). Считать их своей слабостью — наговор на собственную логику ровно того же
// класса, что «не смог проверить» = «не получилось».
describe("отказ канала модели ≠ провал работы", () => {
  it("новые записи различаются по failKind", () => {
    const events = [
      ...Array.from({ length: 8 }, () => ({ ok: true, rounds: 1 })),
      ...Array.from({ length: 3 }, () => ({ ok: false, rounds: 0, failKind: "llm_unavailable", usage: { outputTokens: 0 } })),
      { ok: false, rounds: 4, failKind: "task" },
    ];
    const { tasks, weaknesses } = weaknessesFromMetrics(events);
    expect(tasks.llmUnavailable).toBe(3);
    expect(tasks.failed).toBe(1); // настоящая слабость только одна
    const line = weaknesses.find((w) => w.kind === "llm_unavailable");
    expect(line?.title).toMatch(/чинить надо доступ/); // владельцу сказано, что чинить
  });

  it("старые записи (без поля) опознаются по отпечатку: 0 раундов и 0 выходных токенов", () => {
    const events = [
      ...Array.from({ length: 8 }, () => ({ ok: true, rounds: 1 })),
      ...Array.from({ length: 3 }, () => ({ ok: false, rounds: 0, usage: { outputTokens: 0 } })),
    ];
    expect(weaknessesFromMetrics(events).tasks.llmUnavailable).toBe(3);
  });

  it("провал ПОСЛЕ работы модели остаётся провалом работы (не списывается на канал)", () => {
    const events = [{ ok: false, rounds: 0, usage: { outputTokens: 120 } }];
    const { tasks } = weaknessesFromMetrics(events);
    expect(tasks.failed).toBe(1);
    expect(tasks.llmUnavailable).toBe(0);
  });
});
