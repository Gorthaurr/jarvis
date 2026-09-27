/**
 * W2 П5: ЖИВОЙ смоук кадров — НАСТОЯЩИЙ Electron под Xvfb (desktopCapturer, NativeImage, screen) на масштабах 1 / 1,5 / 2.
 * Сцена и проверки — test-support/xvfb-frames-smoke.ts: красная метка в известной DIP-точке находится на полном кадре
 * (кап std и high) и на зуме, и пересчёт «точка кадра → DIP» попадает в неё численно.
 *
 * Пропускается без Linux/xvfb-run/электрона (на Windows владельца и в песочницах без X) — не красный в обычном прогоне.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const electronBin = ((): string | null => {
  try {
    const p = createRequire(import.meta.url)("electron") as unknown;
    return typeof p === "string" && existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();
const canRun = process.platform === "linux" && existsSync("/usr/bin/xvfb-run") && electronBin !== null;

let dir = "";
let bundle = "";

beforeAll(async () => {
  if (!canRun) return;
  const { build } = await import("esbuild");
  dir = mkdtempSync(join(tmpdir(), "jarvis-frames-smoke-"));
  bundle = join(dir, "smoke.cjs");
  await build({ entryPoints: [resolve(here, "../test-support/xvfb-frames-smoke.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Smoke {
  error?: string;
  display: { bounds: { width: number; height: number }; scaleFactor: number };
  std: { w: number; h: number; n: number; errDip: number };
  high: { w: number; h: number; n: number; errDip: number };
  zoom: { w: number; h: number; sx: number; n: number; markPx: number; errDip: number; zoomOf: boolean };
  ocr: { nativeW: number; nativeH: number; nativeSx: number; tiles: Array<{ width: number; height: number }> };
}

function smoke(scale: number): Smoke {
  const r = spawnSync(
    "xvfb-run",
    ["-a", "-s", "-screen 0 2560x1440x24", electronBin!, "--no-sandbox", "--disable-gpu", `--force-device-scale-factor=${scale}`, bundle],
    { encoding: "utf8", timeout: 150_000 },
  );
  const line = `${r.stdout ?? ""}`.split("\n").find((l) => l.startsWith("SMOKE_RESULT "));
  if (!line) throw new Error(`смоук не отчитался (status ${r.status}): ${(r.stderr ?? "").slice(-800)}`);
  return JSON.parse(line.slice("SMOKE_RESULT ".length)) as Smoke;
}

describe.skipIf(!canRun)("живой смоук кадров под Xvfb (настоящий desktopCapturer)", () => {
  it.each([1, 1.5, 2])("масштаб %s: захват в нативе, копия под кап, зум и пересчёт точки кадра в DIP численно", (scale) => {
    const s = smoke(scale);
    expect(s.error).toBeUndefined();
    expect(s.display.scaleFactor).toBe(scale);
    // Копия под кап: std ≤ 1568 и ≤ 1,15 Мп; high — 1080p-класс (≤ 1920).
    expect(Math.max(s.std.w, s.std.h)).toBeLessThanOrEqual(1568);
    expect(s.std.w * s.std.h).toBeLessThanOrEqual(1_150_000);
    expect(Math.max(s.high.w, s.high.h)).toBeLessThanOrEqual(1920);
    // Метка найдена и точка кадра → DIP попадает в неё (кадр ужат — допуск в пиксель-другой кадра).
    expect(s.std.n).toBeGreaterThan(0);
    expect(s.std.errDip).toBeLessThan(2.5);
    expect(s.high.errDip).toBeLessThan(1.5);
    // Зум — новый захват натива: метка 24 DIP шириной ≈ 24 × px/DIP зума, пересчёт точнее полного кадра.
    expect(s.zoom.zoomOf).toBe(true);
    expect(Math.abs(s.zoom.markPx - 24 * s.zoom.sx)).toBeLessThanOrEqual(2);
    expect(s.zoom.sx).toBeGreaterThanOrEqual(scale * 0.99); // не беднее натива
    expect(s.zoom.errDip).toBeLessThan(0.75);
    // OCR-подготовка: натив региона ×2 (мелкий регион) — ровно одна картинка.
    expect(s.ocr.nativeSx).toBeCloseTo(scale, 2);
    expect(s.ocr.tiles).toEqual([{ width: s.ocr.nativeW * 2, height: s.ocr.nativeH * 2 }]);
  }, 180_000);
});
