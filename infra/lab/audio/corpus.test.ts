import { describe, expect, it } from "vitest";
import { CONDITIONS, buildCorpus, runCorpus, summarize } from "./corpus.js";
import { audioStandAvailability } from "./availability.js";
import { cutHead, onset, prefix } from "./corpus-variants.js";
import { formatReport } from "./corpus-report.js";
import { loadHearing } from "./hearing-rig.js";

const avail = audioStandAvailability();
if (!avail.ok) console.warn(`[audio-corpus] SKIP: ${avail.reason}`);

describe("построение корпуса (без слуха)", () => {
  const full = buildCorpus();

  it("ожидание фиксируется ДО прогона: neg/фон/срез «Джа» — тишина, pos-оригиналы — попадание, обрезки — «не определено»", () => {
    const orig = full.filter((i) => i.group === "оригинал" || i.group === "чужая речь: оригинал");
    expect(orig.filter((i) => i.base.startsWith("pos_")).every((i) => i.expect === "hit")).toBe(true);
    expect(orig.filter((i) => i.base.startsWith("neg_")).every((i) => i.expect === "none")).toBe(true);
    expect(full.filter((i) => i.label === "noise").every((i) => i.expect === "none")).toBe(true);
    expect(full.filter((i) => i.group.startsWith("потеря начала")).every((i) => i.expect === "either")).toBe(true);
    expect(full.filter((i) => i.group.includes("«Джа»")).every((i) => i.expect === "none")).toBe(true);
  });

  it("варианты действительно отличаются от оригинала: громкость, комната, темп, срезы", () => {
    const by = (g: string) => full.find((i) => i.base === "pos_filipp_1" && i.group === g)!;
    const orig = by("оригинал").raw;
    expect(by("громкость×0.3").raw[8000]!).toBeCloseTo(orig[8000]! * 0.3, 4);
    expect(by("комната SNR10").raw).not.toEqual(orig);
    expect(by("темп×1.1").raw.length).toBeLessThan(orig.length);
    expect(by("темп×0.9").raw.length).toBeGreaterThan(orig.length);
    expect(by("потеря начала 250мс").raw.length).toBeLessThan(by("потеря начала 120мс").raw.length);
    expect(by("near-miss: срез «Джа» 250мс").raw.length).toBeLessThan(0.7 * 16_000);
  });

  it("onset находит начало речи после тишины; cutHead/prefix режут от него, а не от нуля файла", () => {
    const x = new Float32Array(16_000);
    for (let i = 8000; i < 16_000; i += 1) x[i] = 0.5 * Math.sin(i / 3);
    expect(onset(x)).toBe(8000);
    expect(cutHead(x, 500).length).toBe(16_000 - 8000 - 8000);
    expect(prefix(x, 250).length).toBe(160 + 4000);
  });

  it("быстрый корпус — только оригиналы и фон", () => {
    const q = buildCorpus({ quick: true });
    expect(q.filter((i) => i.label !== "noise").every((i) => i.group.endsWith("оригинал"))).toBe(true);
    expect(q.length).toBe(6 + 3);
  });
});

describe("сводка (на заданных ячейках, без слуха)", () => {
  const item = (expect_: "hit" | "none" | "either", id: string) => ({ id, base: id, group: "g", label: "pos" as const, expect: expect_, raw: new Float32Array(1) });
  const cells = [
    { item: item("hit", "a"), cond: "c", hit: true, rescue: false, gate: true },
    { item: item("hit", "b"), cond: "c", hit: false, rescue: true, gate: false },
    { item: item("hit", "c"), cond: "c", hit: false, rescue: false, gate: false },
    { item: item("none", "tv"), cond: "c", hit: true, rescue: false, gate: true },
    { item: item("none", "ok"), cond: "c", hit: false, rescue: false, gate: false },
    { item: item("either", "cut"), cond: "c", hit: true, rescue: false, gate: true },
  ];
  it("считает попадания, промахи, спасаемые подстраховкой и ложные срабатывания — без сглаживания", () => {
    const [c] = summarize(cells).byCondition;
    expect(c).toMatchObject({ posN: 3, posHits: 1, misses: 2, rescuable: 1, negN: 2, falsePositives: 1, eitherN: 1, eitherHits: 1 });
  });
  it("ложное срабатывание названо в отчёте поимённо", () => {
    expect(formatReport(summarize(cells), 6)).toContain("- tv @ c");
  });
});

describe.skipIf(!avail.ok)("прогон корпуса через настоящий слух", () => {
  it("оригиналы: «без makeup» ловит 4/4 (как sherpa-hearing.test), ложных 0; отчёт согласован и не подгоняет числа", async () => {
    const load = await loadHearing();
    if (!load.ok) throw new Error(load.reason);
    const items = buildCorpus({ quick: true });
    const rep = summarize(await runCorpus(load, items, CONDITIONS.filter((c) => c.makeup === false || c.preGain === 1)));
    const noMakeup = rep.byCondition.find((c) => c.cond.startsWith("без makeup"))!;
    expect(noMakeup.posN).toBe(4);
    expect(noMakeup.posHits).toBe(4);
    expect(noMakeup.falsePositives).toBe(0);
    for (const c of rep.byCondition) {
      expect(c.falsePositives, c.cond).toBe(0); // ни neg_*, ни тишина/комната/ТВ не будят слух ни при каком усилении
      expect(c.misses).toBe(c.posN - c.posHits);
      expect(c.rescuable).toBeLessThanOrEqual(c.misses);
    }
    const withMakeup = rep.byCondition.find((c) => c.cond === "мик×1 +makeup")!;
    expect(withMakeup.posHits).toBeGreaterThanOrEqual(3); // измерено: makeup×6 на громком TTS роняет часть попаданий (D4)
    const md = formatReport(rep, items.length);
    expect(md).toContain("| мик×1 +makeup |");
    expect(md).toContain("границы измерения");
  }, 60_000);
});
