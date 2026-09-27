/**
 * §Волна2 (2.3): $0-проба региона — «изменилось ли на экране» по 8×8 average-hash яркости (вынесено из screen.ts, W2 П5).
 * НЕ доказательство результата (закон честности: probe ≠ «готово») — только детектор перемен; сверка исхода остаётся за
 * snapshot/OCR/vision. Датчиковый снимок: кадр не регистрируется и ничьих координат не сдвигает.
 */
import { type CaptureRect, grabImage } from "./screen-grab.js";

export interface ScreenProbe {
  /** 64-битный перцептивный хеш (average-hash 8×8) hex-строкой — сравнивать между вызовами. */
  hash: string;
  /** Средняя яркость региона 0..255 (грубый сигнал «тёмный/светлый»). */
  mean: number;
  width: number;
  height: number;
}

/** Хешу 8×8 хватает маленькой копии: натив 4K в PNG ради 64 пикселей не кодируем. */
const PROBE_EDGE = 256;

export async function probeScreen(which?: string | number, rect?: CaptureRect): Promise<ScreenProbe> {
  const g = await grabImage(which, rect, { cap: { maxEdge: PROBE_EDGE } });
  return await perceptualHash(g.img.toPNG().toString("base64"), g.w, g.h);
}

/**
 * Перцептивный хеш УЖЕ СНЯТОГО кадра (§выделение 2026-09-03 — чтобы не снимать экран дважды: взгляд на выделенную
 * область сам считает отпечаток из своего же кадра и честно говорит, изменилось ли там что-то с момента выделения).
 */
export async function perceptualHash(pngBase64: string, width = 0, height = 0): Promise<ScreenProbe> {
  // import(), а не require: main собирается в CJS, но юнит-тесты гоняют ESM с vi.mock("electron").
  const { nativeImage } = await import("electron");
  const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
  const bitmap = img.resize({ width: 8, height: 8 }).toBitmap(); // BGRA 8×8
  const luma: number[] = [];
  for (let i = 0; i + 3 < bitmap.length && luma.length < 64; i += 4) {
    luma.push(0.299 * bitmap[i + 2]! + 0.587 * bitmap[i + 1]! + 0.114 * bitmap[i]!);
  }
  if (luma.length === 0) throw new Error("screen.probe: пустой битмап региона");
  const mean = luma.reduce((a, v) => a + v, 0) / luma.length;
  let hash = 0n;
  for (let i = 0; i < luma.length; i += 1) hash = (hash << 1n) | (luma[i]! >= mean ? 1n : 0n);
  const size = width && height ? { width, height } : img.getSize();
  return { hash: hash.toString(16).padStart(16, "0"), mean: Math.round(mean), width: size.width, height: size.height };
}
