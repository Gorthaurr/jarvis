/**
 * Корпус для слуха и ЧЕСТНЫЙ отчёт долей: hit-rate KWS «Джарвис», ложные срабатывания, доля промахов, которые ловит
 * клиентская подстраховка. Это измерение, а не подгонка: пороги не трогаем, ожидание (`expect`) фиксируется до прогона,
 * а «может/не может» варианты (обрезки слова) идут в отчёте отдельно, без вердикта. Подстраховка измеряется только на
 * КЛИЕНТЕ (отрезок ушёл на проверку); сервер судит её облачным STT — эту половину отчёт не видит и так и говорит.
 */
import { readdirSync } from "node:fs";
import { CORPUS_DIR } from "./availability.js";
import { cutHead, gain, prefix, speed, withRoom } from "./corpus-variants.js";
import { HearingRig, type HearingLoad } from "./hearing-rig.js";
import { type MicOptions, micChain, toFrames } from "./mic-model.js";
import { type NoiseKind, makeNoise } from "./noise.js";
import { loadWav16k } from "./wav.js";

export interface CorpusItem {
  id: string;
  base: string;
  group: string;
  label: "pos" | "neg" | "noise";
  /** hit — обязан сработать; none — обязан промолчать; either — вопрос измерения (обрезки слова). */
  expect: "hit" | "none" | "either";
  raw: Float32Array;
}

export interface Condition extends MicOptions {
  name: string;
}
/** Условия тракта: живой мик тихий (0,01–0,04), корпус громкий (0,6–0,7) — смотрим hit-rate как ФУНКЦИЮ уровня. */
export const CONDITIONS: Condition[] = [
  { name: "мик×1 +makeup", preGain: 1 },
  { name: "мик×0.3 +makeup", preGain: 0.3 },
  { name: "мик×0.05 +makeup (тихий)", preGain: 0.05 },
  { name: "без makeup ×1 (как sherpa-hearing.test)", preGain: 1, makeup: false },
];

export function buildCorpus(opts: { dir?: string; quick?: boolean } = {}): CorpusItem[] {
  const dir = opts.dir ?? CORPUS_DIR;
  const files = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
  const items: CorpusItem[] = [];
  const add = (base: string, g: string, label: CorpusItem["label"], expect: CorpusItem["expect"], raw: Float32Array): void => {
    // neg_* считаем отдельными строками отчёта: смешать «должен сработать» и «должен молчать» в одной доле нельзя
    const group = base.startsWith("neg_") ? `чужая речь: ${g}` : g;
    items.push({ id: `${base}/${g}`, base, group, label, expect, raw });
  };
  for (const f of files) {
    const base = f.replace(/\.wav$/u, "");
    const raw = loadWav16k(`${dir}/${f}`);
    const pos = f.startsWith("pos_");
    const label = pos ? "pos" : "neg";
    const exp = pos ? "hit" : "none";
    add(base, "оригинал", label, exp, raw);
    if (opts.quick) continue;
    for (const g of [0.3, 0.5, 1.5, 2]) add(base, `громкость×${g}`, label, exp, gain(raw, g));
    add(base, "комната SNR20", label, exp, withRoom(raw, 20));
    add(base, "комната SNR10", label, exp, withRoom(raw, 10));
    for (const k of [0.9, 1.1]) add(base, `темп×${k}`, label, exp, speed(raw, k));
    if (pos) {
      add(base, "потеря начала 120мс", "pos", "either", cutHead(raw, 120));
      add(base, "потеря начала 250мс", "pos", "either", cutHead(raw, 250));
      add(base, "near-miss: срез «Джа» 250мс", "neg", "none", prefix(raw, 250));
      add(base, "near-miss: срез 450мс", "neg", "either", prefix(raw, 450));
    }
  }
  for (const k of ["silence", "room", "tv"] as NoiseKind[]) add(`noise-${k}`, "фон 6с", "noise", "none", makeNoise(k, 6000));
  return items;
}

export interface CellResult {
  item: CorpusItem;
  cond: string;
  hit: boolean;
  rescue: boolean;
  gate: boolean;
}

/** Прогнать корпус через НАСТОЯЩИЙ слух (fast: виртуальные часы клиента, сервер не нужен). */
export async function runCorpus(load: Extract<HearingLoad, { ok: true }>, items: CorpusItem[], conds: Condition[] = CONDITIONS): Promise<CellResult[]> {
  const out: CellResult[] = [];
  for (const cond of conds) {
    for (const item of items) {
      const rig = new HearingRig(load.hearing, { frame: () => {}, vad: () => {}, rescue: () => true }, load.tap);
      rig.probe.begin();
      await rig.feed(toFrames(micChain(item.raw, cond)), false);
      out.push({ item, cond: cond.name, hit: rig.probe.wakeFired, rescue: rig.probe.rescueSent, gate: rig.probe.gateOpened });
      rig.dispose();
    }
  }
  return out;
}

export interface CorpusReport {
  cells: CellResult[];
  byCondition: Array<{
    cond: string;
    posN: number;
    posHits: number;
    misses: number;
    rescuable: number;
    negN: number;
    falsePositives: number;
    eitherN: number;
    eitherHits: number;
  }>;
}

export function summarize(cells: CellResult[]): CorpusReport {
  const conds = [...new Set(cells.map((c) => c.cond))];
  return {
    cells,
    byCondition: conds.map((cond) => {
      const of = cells.filter((c) => c.cond === cond);
      const pos = of.filter((c) => c.item.expect === "hit");
      const neg = of.filter((c) => c.item.expect === "none");
      const either = of.filter((c) => c.item.expect === "either");
      const misses = pos.filter((c) => !c.hit);
      return {
        cond,
        posN: pos.length,
        posHits: pos.length - misses.length,
        misses: misses.length,
        rescuable: misses.filter((c) => c.rescue).length,
        negN: neg.length,
        falsePositives: neg.filter((c) => c.hit).length,
        eitherN: either.length,
        eitherHits: either.filter((c) => c.hit).length,
      };
    }),
  };
}
