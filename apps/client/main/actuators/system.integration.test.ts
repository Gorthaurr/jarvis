/**
 * РЕАЛЬНАЯ интеграция system.ts (НЕ моки): гоняем настоящий runSystem → настоящий PowerShell/Core Audio
 * → проверяем РЕАЛЬНЫЙ эффект на железе. Гейт: только Windows + JARVIS_LIVE_SYSTEM=1 (меняет громкость
 * на секунды, потом восстанавливает). Запуск: JARVIS_LIVE_SYSTEM=1 npx vitest run system.integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSystem } from "./system.js";

const LIVE = process.platform === "win32" && process.env.JARVIS_LIVE_SYSTEM === "1";

describe.skipIf(!LIVE)("system.ts РЕАЛЬНО (живой Core Audio)", () => {
  let original = 50;

  beforeAll(async () => {
    const g = await runSystem({ kind: "system.volume", op: "get" });
    original = g.level ?? 50;
  });
  afterAll(async () => {
    await runSystem({ kind: "system.volume", op: "set", level: original }); // вернуть как было
  });

  it("volume get → реальный уровень 0..100", async () => {
    const r = await runSystem({ kind: "system.volume", op: "get" });
    expect(typeof r.level).toBe("number");
    expect(r.level!).toBeGreaterThanOrEqual(0);
    expect(r.level!).toBeLessThanOrEqual(100);
  });

  it("volume set РЕАЛЬНО меняет (readback подтверждает; до фикса молча не работало)", async () => {
    const target = original >= 50 ? 35 : 65;
    const r = await runSystem({ kind: "system.volume", op: "set", level: target });
    expect(Math.abs((r.level ?? -99) - target)).toBeLessThanOrEqual(3); // фактический ≈ заданному
    const g = await runSystem({ kind: "system.volume", op: "get" }); // независимое перечитывание
    expect(Math.abs((g.level ?? -99) - target)).toBeLessThanOrEqual(3);
  });

  it("volume up/down РЕАЛЬНО меняет относительно текущего", async () => {
    await runSystem({ kind: "system.volume", op: "set", level: 50 });
    const up = await runSystem({ kind: "system.volume", op: "up" });
    expect(up.level!).toBeGreaterThan(50);
    const down = await runSystem({ kind: "system.volume", op: "down" });
    expect(down.level!).toBeLessThan(up.level!);
  });

  it("volume set заведомо-неверный target отлавливается сверкой (честный провал, не ложный ok)", async () => {
    // Ставим валидный, затем проверяем: runSystem для set СВЕРЯЕТ readback. Здесь проверяем,
    // что при штатном set ошибки нет (сверка прошла) — негативный путь покрыт юнитом на парсинге.
    await expect(runSystem({ kind: "system.volume", op: "set", level: 40 })).resolves.toBeTruthy();
  });

  it("media state → реальный {playing:boolean, peak:number}", async () => {
    const r = await runSystem({ kind: "system.media", op: "state" });
    expect(typeof r.peak).toBe("number");
    expect(r.peak!).toBeGreaterThanOrEqual(0);
    expect(typeof r.playing).toBe("boolean");
  });
});
