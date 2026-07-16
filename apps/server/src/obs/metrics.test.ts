import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MetricsCollector,
  OPUS_PRICING_USD_PER_MTOK,
  type AgentMetricEvent,
  aggregate,
  estimateCostUsd,
  percentile,
} from "./metrics.js";

/** Фабрика события с разумными дефолтами — тесты переопределяют только нужные поля. */
function ev(over: Partial<AgentMetricEvent> = {}): AgentMetricEvent {
  return {
    tier: "haiku",
    model: "claude-opus-4-8",
    latencyMs: 100,
    rounds: 0,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ok: true,
    ...over,
  };
}

describe("estimateCostUsd — токены→USD по тарифам Opus (чистая)", () => {
  it("1 млн токенов каждого типа = соответствующий тариф", () => {
    expect(
      estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ).toBeCloseTo(OPUS_PRICING_USD_PER_MTOK.input, 6);
    expect(
      estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ).toBeCloseTo(OPUS_PRICING_USD_PER_MTOK.output, 6);
    expect(
      estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }),
    ).toBeCloseTo(OPUS_PRICING_USD_PER_MTOK.cacheRead, 6);
    expect(
      estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 }),
    ).toBeCloseTo(OPUS_PRICING_USD_PER_MTOK.cacheWrite, 6);
  });

  it("складывает типы по тарифу Opus ($5/$25): 1000 in + 500 out", () => {
    const cost = estimateCostUsd({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(cost).toBeCloseTo((1000 * 5 + 500 * 25) / 1_000_000, 9);
  });

  it("прайсит по ФАКТИЧЕСКОЙ модели: Haiku в 5× дешевле Opus на тех же токенах", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const opus = estimateCostUsd(u, "claude-opus-4-8");
    const haiku = estimateCostUsd(u, "claude-haiku-4-5");
    expect(opus).toBeCloseTo(30, 6); // 5 + 25
    expect(haiku).toBeCloseTo(6, 6); // 1 + 5
  });

  it("нулевой usage = $0", () => {
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });
});

describe("percentile — ближайший ранг (чистая)", () => {
  it("пустой массив → 0", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("p50 и p95 на 1..100", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.95)).toBe(95);
  });

  it("p0 = минимум, p100 = максимум", () => {
    expect(percentile([5, 1, 9, 3], 0)).toBe(1);
    expect(percentile([5, 1, 9, 3], 1)).toBe(9);
  });

  it("не мутирует вход", () => {
    const v = [3, 1, 2];
    percentile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe("aggregate — агрегаты по событиям (чистая)", () => {
  it("пустой вход → нули", () => {
    const s = aggregate([]);
    expect(s.requests).toBe(0);
    expect(s.errorRate).toBe(0);
    expect(s.costUsd).toBe(0);
    expect(s.cacheHitRatePct).toBe(0);
    expect(s.latencyMs).toEqual({ p50: 0, p95: 0, avg: 0 });
    expect(s.tokensPerRequest).toBe(0);
  });

  it("суммирует токены по типам и считает стоимость", () => {
    const s = aggregate([
      ev({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 } }),
      ev({ usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheCreationTokens: 0 } }),
    ]);
    expect(s.tokens).toEqual({ input: 300, output: 130, cacheRead: 30, cacheCreation: 5 });
    const expectedCost =
      estimateCostUsd({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 }) +
      estimateCostUsd({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheCreationTokens: 0 });
    expect(s.costUsd).toBeCloseTo(Math.round(expectedCost * 1e6) / 1e6, 9);
  });

  it("costByModel: стоимость разрезана по ФАКТИЧЕСКОЙ модели (не Opus-blind)", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const s = aggregate([ev({ model: "claude-opus-4-8", usage: u }), ev({ model: "claude-haiku-4-5", usage: u })]);
    expect(s.costByModel["claude-opus-4-8"]).toEqual({ costUsd: 5, requests: 1 });
    expect(s.costByModel["claude-haiku-4-5"]).toEqual({ costUsd: 1, requests: 1 });
    expect(s.costUsd).toBeCloseTo(6, 6); // 5 + 1; раньше Opus-blind дал бы 30
  });

  it("error-rate = доля провальных", () => {
    const s = aggregate([ev({ ok: true }), ev({ ok: false }), ev({ ok: false }), ev({ ok: true })]);
    expect(s.requests).toBe(4);
    expect(s.errors).toBe(2);
    expect(s.errorRate).toBe(0.5);
  });

  it("cache hit-rate = cacheRead / (input+cacheRead+cacheCreation) в %", () => {
    // вход-сторона: 100 input + 300 cacheRead + 0 creation = 400; hit = 300/400 = 75%.
    const s = aggregate([
      ev({ usage: { inputTokens: 100, outputTokens: 999, cacheReadTokens: 300, cacheCreationTokens: 0 } }),
    ]);
    expect(s.cacheHitRatePct).toBe(75);
  });

  it("латентность p50/p95/avg", () => {
    const events = Array.from({ length: 100 }, (_, i) => ev({ latencyMs: i + 1 }));
    const s = aggregate(events);
    expect(s.latencyMs.p50).toBe(50);
    expect(s.latencyMs.p95).toBe(95);
    expect(s.latencyMs.avg).toBe(Math.round(((1 + 100) / 2)));
  });

  it("tokensPerRequest = средние токены всех типов на запрос", () => {
    const s = aggregate([
      ev({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
      ev({ usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
    ]);
    // (150 + 250) / 2 = 200
    expect(s.tokensPerRequest).toBe(200);
  });
});

describe("MetricsCollector — синглтон-коллектор", () => {
  it("record → snapshot отражает записанное", () => {
    const c = new MetricsCollector(100);
    c.record(ev({ ok: true, latencyMs: 10 }));
    c.record(ev({ ok: false, latencyMs: 30 }));
    const s = c.snapshot();
    expect(s.requests).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBe(0.5);
  });

  it("ring-buffer: при переполнении окна держит последние cap событий", () => {
    const c = new MetricsCollector(3);
    for (let i = 0; i < 10; i += 1) c.record(ev({ latencyMs: i }));
    const s = c.snapshot();
    expect(s.requests).toBe(3); // только последние 3
    // последние 3 латентности: 7,8,9 → avg = 8
    expect(s.latencyMs.avg).toBe(8);
  });

  it("reset очищает окно", () => {
    const c = new MetricsCollector(10);
    c.record(ev());
    c.reset();
    expect(c.snapshot().requests).toBe(0);
  });
});

describe("MetricsCollector durable JSONL (аудит 2026-07-02)", () => {
  let dir: string;
  const prevEnv = process.env.JARVIS_DATA_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-metrics-"));
    process.env.JARVIS_DATA_DIR = dir;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.JARVIS_DATA_DIR;
    else process.env.JARVIS_DATA_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("enableJsonl → каждое событие дописывается строкой в logs/metrics.jsonl (с costUsd)", () => {
    const c = new MetricsCollector(10);
    c.enableJsonl();
    c.record(ev({ latencyMs: 111, ok: false }));
    c.record(ev({ latencyMs: 222 }));
    const path = join(dir, "logs", "metrics.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ latencyMs: 111, ok: false });
    expect(typeof rec.costUsd).toBe("number"); // стоимость по фактической модели дописана
    expect(typeof rec.ts).toBe("string");
  });

  it("по умолчанию (без enableJsonl) на диск НЕ пишет — только окно в ОЗУ", () => {
    const c = new MetricsCollector(10);
    c.record(ev());
    expect(existsSync(join(dir, "logs", "metrics.jsonl"))).toBe(false);
    expect(c.snapshot().requests).toBe(1);
  });

  it("disableJsonl прекращает запись", () => {
    const c = new MetricsCollector(10);
    c.enableJsonl();
    c.record(ev());
    c.disableJsonl();
    c.record(ev());
    const lines = readFileSync(join(dir, "logs", "metrics.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1); // только первое событие
  });

  it("recordMouthToEar (инкремент 0) → строка type:mouth_to_ear с ms/turnSeq/userId", () => {
    const c = new MetricsCollector(10);
    c.enableJsonl();
    c.recordMouthToEar(742, 3, "user-abc");
    const lines = readFileSync(join(dir, "logs", "metrics.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ type: "mouth_to_ear", ms: 742, turnSeq: 3, userId: "user-abc" });
    expect(typeof rec.ts).toBe("string");
  });

  it("recordMouthToEar не попадает в ОЗУ-окно per-task агрегатов (иной масштаб события)", () => {
    const c = new MetricsCollector(10);
    c.enableJsonl();
    c.recordMouthToEar(500, 1);
    expect(c.snapshot().requests).toBe(0); // не аггрегат задачи
  });

  it("recordMouthToEar без enableJsonl — no-op (на диск не пишет)", () => {
    const c = new MetricsCollector(10);
    c.recordMouthToEar(500, 1);
    expect(existsSync(join(dir, "logs", "metrics.jsonl"))).toBe(false);
  });

  it("ротация по размеру: превышение cap → metrics.jsonl.1, свежие данные целы (ревью 2026-07-15)", () => {
    const c = new MetricsCollector(10, { maxJsonlBytes: 400 }); // тест-cap мимо env-клампа 1МБ
    c.enableJsonl();
    const path = join(dir, "logs", "metrics.jsonl");
    for (let i = 0; i < 20; i += 1) c.record(ev({ latencyMs: i })); // строки ~190Б → несколько ротаций
    expect(existsSync(`${path}.1`)).toBe(true); // прошлая генерация сохранена (не удалена по возрасту)
    expect(existsSync(path)).toBe(true); // текущий продолжает писаться
    // Текущий файл ограничен ~cap (данные не потеряны — они в .1); последнее событие точно на месте.
    const cur = readFileSync(path, "utf8").trim().split("\n");
    expect(JSON.parse(cur[cur.length - 1]!)).toMatchObject({ latencyMs: 19 });
    expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(400 + 300);
  });

  it("ротация: транзиентный провал rename не сбрасывает счётчик ложно → повтор на СЛЕДУЮЩЕЙ записи (ревью #2/#3)", () => {
    const path = join(dir, "logs", "metrics.jsonl");
    // Детерминированно (без байт-хрупкости): измеряем размер одной записи, cap = ровно 5 записей → порог
    // пересекается на 6-й. Блокируем .1 каталогом (renameSync обречён бросать), пишем 6 (ротация падает),
    // СНИМАЕМ блок и пишем ещё 1. ФИКС: счётчик после провала остался у порога (~6 записей) → 7-я запись
    // СРАЗУ ротирует. БАГ (сброс в 0): после провала счётчик ~1 запись → 7-я (2 записи) < cap(5) → НЕ ротирует.
    const probe = new MetricsCollector(10);
    probe.enableJsonl();
    probe.record(ev({ latencyMs: 0 }));
    const recBytes = statSync(path).size;
    rmSync(path);
    const c = new MetricsCollector(10, { maxJsonlBytes: recBytes * 5 });
    c.enableJsonl();
    mkdirSync(`${path}.1`); // .1 — КАТАЛОГ → renameSync(path→.1) бросает → rotate() вернёт false
    expect(() => {
      for (let i = 0; i < 6; i += 1) c.record(ev({ latencyMs: i })); // 6-я пересекает порог → rotate падает
    }).not.toThrow();
    expect(existsSync(`${path}.1`) && statSync(`${path}.1`).isDirectory()).toBe(true); // ротации не было (блок держит)
    rmSync(`${path}.1`, { recursive: true }); // снимаем блок
    c.record(ev({ latencyMs: 6 })); // 7-я запись: под фиксом счётчик у порога → ротирует немедленно
    expect(statSync(`${path}.1`).isFile()).toBe(true); // .1 — ФАЙЛ: ротация сработала на первой же записи после снятия
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1); // свежий файл = только 7-я запись
  });

  it("startProcessHealth → durable-строка type:process_health (rss/heap/uptime/node)", () => {
    const c = new MetricsCollector(10);
    c.enableJsonl();
    c.startProcessHealth(600_000); // первую строку пишем сразу, интервал не успеет сработать
    c.stopProcessHealth(); // сразу гасим таймер — тест не течёт
    const lines = readFileSync(join(dir, "logs", "metrics.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.type).toBe("process_health");
    expect(typeof rec.rssMb).toBe("number");
    expect(typeof rec.heapUsedMb).toBe("number");
    expect(typeof rec.uptimeSec).toBe("number");
    expect(typeof rec.node).toBe("string");
  });

  it("startProcessHealth без enableJsonl — no-op (таймер не стартует, файла нет)", () => {
    const c = new MetricsCollector(10);
    c.startProcessHealth(600_000);
    c.stopProcessHealth();
    expect(existsSync(join(dir, "logs", "metrics.jsonl"))).toBe(false);
  });
});
