/**
 * W2 П5: ЖИВОЙ смоук кадров под Xvfb — НАСТОЯЩИЙ Electron (desktopCapturer, NativeImage crop/resize/PNG, screen) и
 * настоящие screen.ts / screen-grab.ts / frames.ts / coords.ts / screen-ocr-tiles.ts. Собирается esbuild'ом и
 * запускается электроном (frames-xvfb.test.ts) на масштабах 1 / 1,5 / 2 (--force-device-scale-factor).
 *
 * Сцена: окно во весь монитор, белый фон, красная метка 24×24 DIP в известной DIP-точке. Проверки численно:
 *  - полный кадр (кап std и high): центроид метки на картинке → toDipPoint(кадр) = известный DIP;
 *  - зум (новый захват кропом натива) вокруг метки → центроид → toDipPoint(z-кадр) = тот же DIP, точнее;
 *  - натив: метка на зуме шириной ≈ 24 × px/DIP зума (детали не из миниатюры);
 *  - OCR-подготовка: мелкий регион уходит в «сайдкар» ×2 от натива.
 * Итог — строка `SMOKE_RESULT {json}` в stdout; код выхода 0/1.
 */
import { BrowserWindow, app, nativeImage, screen } from "electron";
import { toDipPoint } from "../actuators/coords.js";
import { getFrame } from "../actuators/frames.js";
import { captureScreen } from "../actuators/screen.js";
import { grabImage } from "../actuators/screen-grab.js";
import { ocrTiles } from "../actuators/screen-ocr-tiles.js";

const MARK = 24;

/** Центроид красных пикселей картинки (BGRA) — в её пикселях. */
function redCentroid(b64: string): { x: number; y: number; n: number; w: number } {
  const img = nativeImage.createFromBuffer(Buffer.from(b64, "base64"));
  const { width } = img.getSize();
  const bmp = img.toBitmap();
  let sx = 0;
  let sy = 0;
  let n = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = -1;
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    if (bmp[i + 2]! > 200 && bmp[i + 1]! < 60 && bmp[i]! < 60) {
      const p = i / 4;
      const x = p % width;
      sx += x + 0.5;
      sy += Math.floor(p / width) + 0.5;
      n += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  return { x: sx / Math.max(1, n), y: sy / Math.max(1, n), n, w: n ? maxX - minX + 1 : 0 };
}

async function main(): Promise<Record<string, unknown>> {
  const d = screen.getPrimaryDisplay();
  const b = d.bounds;
  const target = { x: Math.round(b.width * 0.61), y: Math.round(b.height * 0.37) }; // левый верх метки, DIP
  const want = { x: target.x + MARK / 2, y: target.y + MARK / 2 };
  const win = new BrowserWindow({ ...b, frame: false, show: false, backgroundColor: "#ffffff", webPreferences: { offscreen: false } });
  const html = `<body style="margin:0;background:#fff"><div style="position:absolute;left:${target.x}px;top:${target.y}px;width:${MARK}px;height:${MARK}px;background:#f00"></div></body>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.showInactive();
  await new Promise((r) => setTimeout(r, 1200));

  const err = (p: { x: number; y: number }) => Math.hypot(p.x - want.x, p.y - want.y);
  const std = await captureScreen("0");
  const high = await captureScreen("0", { maxEdge: 1920, maxPixels: 3_750_000 });
  const fStd = getFrame(std.frameId!);
  const fHigh = getFrame(high.frameId!);
  const cStd = redCentroid(std.image);
  const cHigh = redCentroid(high.image);
  const dipStd = toDipPoint(cStd.x, cStd.y, { frame: fStd.id });
  const dipHigh = toDipPoint(cHigh.x, cHigh.y, { frame: fHigh.id });

  // Зум: регион 80×80 DIP вокруг метки, заданный в системе кадра high (как модель).
  const r = { x: (want.x - 40) * fHigh.sx, y: (want.y - 40) * fHigh.sy, w: 80 * fHigh.sx, h: 80 * fHigh.sy };
  const zoom = await captureScreen(undefined, { rect: { ...r, frame: fHigh.id }, maxEdge: 2576, maxPixels: 3_750_000 });
  const fZoom = getFrame(zoom.frameId!);
  const cZoom = redCentroid(zoom.image);
  const dipZoom = toDipPoint(cZoom.x, cZoom.y, { frame: fZoom.id });

  // OCR-подготовка на настоящем NativeImage: мелкий регион → в «сайдкар» уходит ×2 от натива.
  const g = await grabImage(undefined, { ...r, frame: fHigh.id });
  const tiles: Array<{ width: number; height: number }> = [];
  await ocrTiles(g.img, g.w, g.h, async (b64) => (tiles.push(nativeImage.createFromBuffer(Buffer.from(b64, "base64")).getSize()), { text: "", lines: [] }));

  return {
    display: { bounds: b, scaleFactor: d.scaleFactor },
    std: { w: std.width, h: std.height, sx: fStd.sx, n: cStd.n, errDip: err(dipStd) },
    high: { w: high.width, h: high.height, sx: fHigh.sx, n: cHigh.n, errDip: err(dipHigh) },
    zoom: { w: zoom.width, h: zoom.height, sx: fZoom.sx, n: cZoom.n, markPx: cZoom.w, errDip: err(dipZoom), zoomOf: zoom.zoomOf === fHigh.id },
    ocr: { nativeW: g.w, nativeH: g.h, nativeSx: g.nativeSx, tiles },
  };
}

app.whenReady().then(async () => {
  try {
    const res = await main();
    console.log(`SMOKE_RESULT ${JSON.stringify(res)}`);
    app.exit(0);
  } catch (e) {
    console.log(`SMOKE_RESULT ${JSON.stringify({ error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) })}`);
    app.exit(1);
  }
});
