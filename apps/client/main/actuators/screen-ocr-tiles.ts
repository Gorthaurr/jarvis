/**
 * W2 П5: подготовка картинки к Windows.Media.Ocr — мелкий регион ×2, крупный натив полосами с перекрытием.
 *
 * `OcrEngine.MaxImageDimension` на живой машине ещё не измерен (§6 C#: операция `ocr.limits`) — консервативно 2600:
 * ×2 применяется, только если результат не выходит за кламп, а натив крупнее (4K) режется на полосы. Строка,
 * попавшая в перекрытие двух полос, засчитывается той полосе, в чьё ЯДРО (половина перекрытия) лёг её центр, —
 * без дублей. Строки возвращаются в пикселях ИСХОДНОЙ (нативной) картинки.
 */
import type { NativeImage } from "electron";

export interface TileLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const OCR_MAX_DIM = 2600;
/** Регион не длиннее этого — ×2 (и не выходит за кламп). */
export const OCR_SMALL_EDGE = OCR_MAX_DIM / 2;
const OVERLAP = 96;

interface Span {
  a: number;
  b: number;
  /** Ядро полосы [lo, hi): кому засчитать строку из перекрытия. */
  lo: number;
  hi: number;
}

/** Разбить длину на полосы ≤ max с перекрытием; ядра стыкуются без щелей. */
export function spans(len: number, max = OCR_MAX_DIM, overlap = OVERLAP): Span[] {
  if (len <= max) return [{ a: 0, b: len, lo: 0, hi: len }];
  const n = Math.ceil((len - overlap) / (max - overlap));
  const step = (len - overlap) / n;
  const out: Span[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = Math.floor(i * step);
    const b = i === n - 1 ? len : Math.min(len, Math.ceil(i * step + step + overlap));
    out.push({ a, b, lo: i === 0 ? 0 : a + overlap / 2, hi: i === n - 1 ? len : b - overlap / 2 });
  }
  return out;
}

type OcrRpc = (imageB64: string) => Promise<unknown>;

const finite = (l: Partial<TileLine>): l is TileLine => typeof l?.text === "string" && [l.x, l.y, l.w, l.h].every((n) => typeof n === "number" && Number.isFinite(n));

/** Распознать картинку w×h (натив региона): ×2 для мелкой, полосы для крупной. Строки — в пикселях натива. */
export async function ocrTiles(img: NativeImage, w: number, h: number, rpc: OcrRpc): Promise<{ text: string; lines: TileLine[]; tiles: number; factor: number }> {
  const factor = Math.max(w, h) <= OCR_SMALL_EDGE ? 2 : 1;
  const W = w * factor;
  const H = h * factor;
  const prep = factor === 1 ? img : img.resize({ width: W, height: H, quality: "best" });
  const xs = spans(W);
  const ys = spans(H);
  const single = xs.length === 1 && ys.length === 1;
  const lines: TileLine[] = [];
  let text = "";
  for (const sy of ys) {
    for (const sx of xs) {
      const tile = single ? prep : prep.crop({ x: sx.a, y: sy.a, width: sx.b - sx.a, height: sy.b - sy.a });
      const data = ((await rpc(tile.toPNG().toString("base64"))) ?? {}) as { text?: unknown; lines?: unknown };
      if (single) text = String(data.text ?? "");
      for (const l of Array.isArray(data.lines) ? (data.lines as Array<Partial<TileLine>>) : []) {
        if (!finite(l)) continue;
        const cx = sx.a + l.x + l.w / 2;
        const cy = sy.a + l.y + l.h / 2;
        if (!single && (cx < sx.lo || cx >= sx.hi || cy < sy.lo || cy >= sy.hi)) continue; // дубль из перекрытия
        lines.push({ text: l.text, x: (sx.a + l.x) / factor, y: (sy.a + l.y) / factor, w: l.w / factor, h: l.h / factor });
      }
    }
  }
  if (!single) text = [...lines].sort((p, q) => p.y - q.y || p.x - q.x).map((l) => l.text).join("\n");
  return { text, lines, tiles: xs.length * ys.length, factor };
}
