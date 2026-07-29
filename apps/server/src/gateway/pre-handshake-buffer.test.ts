/**
 * Политика pre-handshake буфера (P0 «речь теряется» + раунд-4 ревью). Ключевой инвариант: кадры,
 * пришедшие за время async-handshake, доезжают до сессии, а защита от переполнения НИКОГДА не
 * стоит дороже, чем сам сохраняемый смысл (жирный посторонний кадр не выносит буфер речи).
 */
import { describe, expect, it } from "vitest";
import { PreHandshakeBuffer } from "./pre-handshake-buffer.js";

describe("PreHandshakeBuffer", () => {
  it("копит кадры в исходном порядке и отдаёт их drain'ом", () => {
    const buf = new PreHandshakeBuffer<string>(10, 1000);
    buf.push("a", 10);
    buf.push("b", 10);
    buf.push("c", 10);
    expect(buf.size).toBe(3);
    expect(buf.drain()).toEqual(["a", "b", "c"]);
    expect(buf.size).toBe(0);
  });

  it("переполнение по числу кадров вытесняет СТАРЕЙШИЕ (конец фразы ценнее начала)", () => {
    const buf = new PreHandshakeBuffer<number>(3, 10_000);
    for (let i = 1; i <= 5; i++) buf.push(i, 10);
    expect(buf.drain()).toEqual([3, 4, 5]);
    expect(buf.droppedCount).toBe(2);
  });

  it("переполнение по БАЙТАМ вытесняет старейшие (кап меряет сырые ws-сообщения)", () => {
    const buf = new PreHandshakeBuffer<string>(100, 250);
    buf.push("x1", 100);
    buf.push("x2", 100);
    buf.push("x3", 100); // 300 > 250 → вытесняем старейший
    expect(buf.drain()).toEqual(["x2", "x3"]);
    expect(buf.droppedCount).toBe(1);
  });

  // РАУНД-4 РЕВЬЮ (главный регресс-кейс): кадр толще всего капа отвергается ДО постановки —
  // раньше он вытеснял ВЕСЬ накопленный буфер речи по одному, а затем отбрасывался и сам.
  it("сверх-жирный кадр отвергается СРАЗУ и НЕ уносит накопленную речь", () => {
    const buf = new PreHandshakeBuffer<string>(600, 1000);
    for (let i = 0; i < 5; i++) buf.push(`речь${i}`, 100); // 500 байт речи
    const out = buf.push("жирный-дамп", 5000); // толще капа целиком
    expect(out.rejectedOversize).toBe(true);
    expect(out.evicted).toBe(0);
    expect(buf.drain()).toEqual(["речь0", "речь1", "речь2", "речь3", "речь4"]); // речь ЦЕЛА
    expect(buf.droppedCount).toBe(1); // потерян только нарушитель — и он посчитан
  });

  it("одиночный кадр в пределах капа остаётся даже при жёстком байтовом лимите", () => {
    const buf = new PreHandshakeBuffer<string>(600, 100);
    buf.push("ровно-по-капу", 100);
    expect(buf.size).toBe(1);
    expect(buf.drain()).toEqual(["ровно-по-капу"]);
  });

  it("счётчик потерь переживает drain — итоговый WARN не теряет факт потери", () => {
    const buf = new PreHandshakeBuffer<number>(2, 10_000);
    for (let i = 1; i <= 5; i++) buf.push(i, 1);
    expect(buf.droppedCount).toBe(3);
    buf.drain();
    expect(buf.droppedCount).toBe(3); // после реплея по-прежнему видно, сколько потеряли
  });
});
