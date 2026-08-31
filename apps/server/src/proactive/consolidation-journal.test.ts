// Волна F (F3): durable-журнал сон-цикла — витрина «что фоновая консолидация записала».
import { afterAll, describe, expect, it, vi } from "vitest";

const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const dir = `${base}/jarvis-consjournal-test-${process.pid}-${Date.now()}`;
  process.env.JARVIS_DATA_DIR = dir;
  return dir;
});

import { appendFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { appendConsolidationRun, readConsolidationRuns } from "./consolidation-journal.js";

const U = "cccccccc-cccc-cccc-cccc-cccccccccccc";

afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("consolidation-journal (F3)", () => {
  it("append → read round-trip, новые первыми", async () => {
    await appendConsolidationRun(U, { ts: 1000, extracted: 3, written: 2, dropped: 1, facts: ["а", "б"] });
    await appendConsolidationRun(U, { ts: 2000, extracted: 1, written: 1, dropped: 0, facts: ["в"] });
    const runs = await readConsolidationRuns(U);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.ts).toBe(2000); // свежий первым
    expect(runs[1]?.written).toBe(2);
    expect(runs[1]?.facts).toEqual(["а", "б"]);
  });

  it("битая строка журнала пропускается, не роняет чтение", async () => {
    const dir = join(TMP, "memory");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `consolidation-${U}.jsonl`), "НЕ JSON\n", "utf8");
    const runs = await readConsolidationRuns(U);
    expect(runs.length).toBeGreaterThanOrEqual(2); // прежние записи целы
  });

  it("нет файла → пустой список (не ошибка)", async () => {
    expect(await readConsolidationRuns("no-such-user")).toEqual([]);
  });

  it("limit уважается", async () => {
    expect((await readConsolidationRuns(U, 1)).length).toBe(1);
  });

  // 🔴 Контроль волны F: прогон, где ВСЁ отбил анти-инъекционный фильтр, — самое важное событие
  // витрины, а ранний return оставлял её пустой («Сон-цикл ещё ничего не записывал»).
  it("прогон с dropped>0 и нулём записанных фактов журналируется, числа арифметичны", async () => {
    const U2 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await appendConsolidationRun(U2, { ts: 5000, extracted: 3, written: 0, dropped: 3, facts: [] });
    const [run] = await readConsolidationRuns(U2);
    expect(run?.dropped).toBe(3);
    expect(run?.extracted).toBeGreaterThanOrEqual((run?.dropped ?? 0) + (run?.written ?? 0));
  });
});
