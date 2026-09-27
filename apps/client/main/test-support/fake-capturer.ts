/**
 * W2 П5: ФЕЙКОВЫЙ desktopCapturer + NativeImage с «происхождением» пикселей и мониторы с масштабом — для тестов кадров,
 * зума и OCR на НАСТОЯЩИХ screen.ts / screen-grab.ts / screen-ocr.ts.
 *
 * Картинка помнит, какой кусок ФИЗИЧЕСКОГО экрана своего монитора она показывает: пиксель (x, y) картинки = физический
 * пиксель (ox + x / kx, oy + y / ky). crop/resize пересчитывают это честно (как настоящий Electron), toPNG кодирует
 * происхождение в «PNG» — фейковый OCR-сайдкар по нему «видит» слова, лежащие в физических координатах монитора, и
 * отдаёт строки в пикселях присланной картинки. Так тест проверяет всю цепочку «натив → кадр → DIP» числами.
 *
 * Подключение:
 *   vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
 *   beforeEach(() => resetCapturer([{ id: 1, bounds: {...}, scaleFactor: 1.5 }]));
 */
import { electronModule, electronState, resetElectronMock } from "./electron-mock.js";

export interface Prov {
  display: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
  kx: number;
  ky: number;
}

export class FakeImage {
  constructor(readonly p: Prov) {}
  getSize(): { width: number; height: number } {
    return { width: this.p.w, height: this.p.h };
  }
  isEmpty(): boolean {
    return this.p.w === 0 || this.p.h === 0;
  }
  crop(r: { x: number; y: number; width: number; height: number }): FakeImage {
    const p = this.p;
    return new FakeImage({ ...p, w: r.width, h: r.height, ox: p.ox + r.x / p.kx, oy: p.oy + r.y / p.ky });
  }
  resize(s: { width?: number; height?: number }): FakeImage {
    const p = this.p;
    const width = s.width ?? Math.round((p.w * (s.height ?? p.h)) / p.h);
    const height = s.height ?? Math.round((p.h * width) / p.w);
    return new FakeImage({ ...p, w: width, h: height, kx: (p.kx * width) / p.w, ky: (p.ky * height) / p.h });
  }
  toPNG(): Buffer {
    return Buffer.from(JSON.stringify(this.p));
  }
  toBitmap(): Buffer {
    return Buffer.alloc(this.p.w * this.p.h * 4, 128);
  }
}

/** Происхождение картинки из base64 «PNG» (то, что ушло в сайдкар/модель). */
export const provOf = (b64: string): Prov => JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Prov;

export interface FakeDisplay {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export const capturer = {
  displays: [] as FakeDisplay[],
  /** Запросы getSources (thumbnailSize). */
  requests: [] as Array<{ width: number; height: number }>,
  /** Реальный размер миниатюры по запрошенному (деф — как Chromium: вписать физику в запрос). Подмена — «2559×1439». */
  actual: null as null | ((req: { width: number; height: number }, phys: { width: number; height: number }) => { width: number; height: number }),
  cursor: { x: 0, y: 0 },
};

const physOf = (d: FakeDisplay) => ({ width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) });
const fit = (req: { width: number; height: number }, phys: { width: number; height: number }) => {
  const k = Math.min(req.width / phys.width, req.height / phys.height, 1);
  return { width: Math.floor(phys.width * k), height: Math.floor(phys.height * k) };
};

export function resetCapturer(displays: FakeDisplay[]): void {
  resetElectronMock();
  capturer.displays = displays;
  capturer.requests = [];
  capturer.actual = null;
  capturer.cursor = { x: displays[0]?.bounds.x ?? 0, y: displays[0]?.bounds.y ?? 0 };
  // Физика ↔ DIP мока электрона — по масштабу первого монитора (Windows-API на Linux нет).
  electronState.scale = displays[0]?.scaleFactor ?? 1;
  electronState.displays = displays.map((d) => ({ ...d, size: { width: d.bounds.width, height: d.bounds.height } }));
}

const contains = (d: FakeDisplay, p: { x: number; y: number }): boolean =>
  p.x >= d.bounds.x && p.y >= d.bounds.y && p.x < d.bounds.x + d.bounds.width && p.y < d.bounds.y + d.bounds.height;

export function fakeElectronModule(): Record<string, unknown> {
  return {
    ...electronModule,
    screen: {
      ...electronModule.screen,
      getDisplayNearestPoint: (p: { x: number; y: number }) => electronState.displays.find((d) => contains(d, p)) ?? electronState.displays[0],
      getCursorScreenPoint: () => capturer.cursor,
    },
    desktopCapturer: {
      getSources: async (o: { thumbnailSize: { width: number; height: number } }) => {
        capturer.requests.push({ ...o.thumbnailSize });
        return capturer.displays.map((d) => {
          const phys = physOf(d);
          const size = (capturer.actual ?? fit)(o.thumbnailSize, phys);
          const img = new FakeImage({ display: d.id, w: size.width, h: size.height, ox: 0, oy: 0, kx: size.width / phys.width, ky: size.height / phys.height });
          return { id: `screen:${d.id}:0`, display_id: String(d.id), thumbnail: img };
        });
      },
    },
    nativeImage: { createFromBuffer: (b: Buffer) => new FakeImage(JSON.parse(b.toString("utf8")) as Prov) },
  };
}

/** Слово на экране монитора (ФИЗИЧЕСКИЕ пиксели монитора) — фейковый OCR «видит» его на присланной картинке. */
export interface ScreenWord {
  display: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ответ фейкового OCR-сайдкара: слова, ЦЕЛИКОМ попавшие в картинку, — в её пикселях. */
export function ocrSees(words: ScreenWord[], imageB64: string): { text: string; lines: Array<{ text: string; x: number; y: number; w: number; h: number }> } {
  const p = provOf(imageB64);
  const lines = words
    .filter((wd) => wd.display === p.display)
    .map((wd) => ({ text: wd.text, x: (wd.x - p.ox) * p.kx, y: (wd.y - p.oy) * p.ky, w: wd.w * p.kx, h: wd.h * p.ky }))
    .filter((l) => l.x >= 0 && l.y >= 0 && l.x + l.w <= p.w + 0.01 && l.y + l.h <= p.h + 0.01);
  return { text: lines.map((l) => l.text).join("\n"), lines };
}
