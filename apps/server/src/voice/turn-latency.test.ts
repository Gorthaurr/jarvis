/**
 * B4 (аудит прод-логов 27.09): латентность по ходам. Проводка в пайплайн — pipeline.streaming.test.ts (B4);
 * здесь — инварианты самого трекера ходов.
 */
import { describe, expect, it } from "vitest";
import { TurnLatency } from "./turn-latency.js";

describe("TurnLatency — трекер на ход", () => {
  it("звук хода 1 после открытия хода 2 метит ход 1; отчёт хода 2 его не видит", () => {
    let t = 0;
    const lat = new TurnLatency(() => t);
    lat.begin(1);
    t = 1_000;
    lat.mark(1, "turn_end");
    t = 1_500;
    lat.begin(2); // новый лиз, пока ход 1 думает
    t = 3_000;
    expect(lat.sound(1)?.firstAudioMs).toBe(2_000);
    t = 5_000;
    lat.mark(2, "turn_end");
    t = 6_000;
    expect(lat.sound(2)?.firstAudioMs).toBe(1_000); // не 3 000 − 5 000 < 0 («оборот неполный»)
  });

  it("звук без хода (проактив) и забытого хода не метит никого и отчёта не даёт", () => {
    const lat = new TurnLatency(() => 42);
    lat.begin(1);
    lat.mark(1, "turn_end");
    expect(lat.sound(undefined)).toBeUndefined();
    expect(lat.sound(7)).toBeUndefined();
    expect(lat.report(1).marks.audio).toBeUndefined();
  });

  it("помнит ограниченное число последних ходов — старые вытесняются, свежие целы", () => {
    const lat = new TurnLatency(() => 0);
    for (let seq = 1; seq <= 20; seq += 1) lat.begin(seq);
    expect(lat.sound(1)).toBeUndefined(); // давно забыт — память не растёт с каждым лизом
    expect(lat.sound(20)).toBeDefined();
  });

  it("answer() запоминает ход в работе — earcon приёмки метит его, а не свежий лиз", () => {
    let t = 0;
    const lat = new TurnLatency(() => t);
    lat.begin(1);
    lat.mark(1, "turn_end");
    expect(lat.answer(1)).toBe(1);
    lat.begin(2); // речь в раздумье открыла лиз 2
    t = 700;
    expect(lat.sound(lat.answeringSeq)?.firstAudioMs).toBe(700);
    expect(lat.report(2).marks.audio).toBeUndefined();
  });
});
