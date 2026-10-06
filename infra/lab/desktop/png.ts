/**
 * Синтетический PNG без зависимостей (node:zlib): «экран» FakeDesktop рисуется прямоугольниками и блочным «текстом».
 * Картинка настоящая (декодируется любым просмотрщиком/зрением модели), но её содержимое — сцена из состояния окон:
 * сменилось состояние — сменились пиксели (на этом стоит screen.probe «изменилось ли»).
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA (w*h*4) → PNG. */
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  if (w < 1 || h < 1 || rgba.length !== w * h * 4) throw new Error(`png: размер ${w}x${h} не сходится с буфером ${rgba.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 бит на канал
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0; // фильтр «нет»
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 3 })), chunk("IEND", new Uint8Array(0))]);
}

/** Размер и признак валидности PNG по заголовку (для тестов и проверок формы). */
export function pngInfo(png: Buffer | string): { width: number; height: number } {
  const b = typeof png === "string" ? Buffer.from(png, "base64") : png;
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("ascii", 12, 16) !== "IHDR") throw new Error("не PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export type Rgb = readonly [number, number, number];

export class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: Rgb = [0, 0, 0],
  ) {
    this.data = new Uint8Array(w * h * 4);
    this.rect(0, 0, w, h, bg);
  }

  /** Залить прямоугольник (координаты кламп по границам холста). */
  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        const i = (yy * this.w + xx) * 4;
        this.data[i] = c[0];
        this.data[i + 1] = c[1];
        this.data[i + 2] = c[2];
        this.data[i + 3] = 255;
      }
    }
  }

  /** Рамка в 1 px. */
  frame(x: number, y: number, w: number, h: number, c: Rgb): void {
    this.rect(x, y, w, 1, c);
    this.rect(x, y + h - 1, w, 1, c);
    this.rect(x, y, 1, h, c);
    this.rect(x + w - 1, y, 1, h, c);
  }

  /** «Текст» блоками 3×5 (узор — из кода символа): читать глазами нельзя, но меняется вместе с текстом. */
  text(x: number, y: number, s: string, px: number, c: Rgb, maxW = Number.POSITIVE_INFINITY): void {
    let cx = x;
    for (const ch of s) {
      if (cx + 4 * px > x + maxW) return;
      if (ch !== " ") {
        const code = ch.codePointAt(0) ?? 0;
        let bits = (code * 2654435761) >>> 0; // хеш Кнута: 15 бит узора
        for (let r = 0; r < 5; r += 1) {
          for (let k = 0; k < 3; k += 1) {
            if (bits & 1) this.rect(cx + k * px, y + r * px, px, px, c);
            bits >>>= 1;
          }
        }
      }
      cx += 4 * px;
    }
  }

  /** Среднее-хеш 8×8 по яркости (64-битный hex) и средняя яркость — как у настоящего screen.probe. */
  probe(): { hash: string; mean: number } {
    const luma: number[] = [];
    for (let by = 0; by < 8; by += 1) {
      for (let bx = 0; bx < 8; bx += 1) {
        const x0 = Math.floor((bx * this.w) / 8);
        const x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * this.w) / 8));
        const y0 = Math.floor((by * this.h) / 8);
        const y1 = Math.max(y0 + 1, Math.floor(((by + 1) * this.h) / 8));
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1 && y < this.h; y += 1) {
          for (let x = x0; x < x1 && x < this.w; x += 1) {
            const i = (y * this.w + x) * 4;
            sum += 0.299 * this.data[i]! + 0.587 * this.data[i + 1]! + 0.114 * this.data[i + 2]!;
            n += 1;
          }
        }
        luma.push(n ? sum / n : 0);
      }
    }
    const mean = luma.reduce((a, v) => a + v, 0) / luma.length;
    let hash = 0n;
    for (const v of luma) hash = (hash << 1n) | (v >= mean ? 1n : 0n);
    return { hash: hash.toString(16).padStart(16, "0"), mean: Math.round(mean) };
  }

  toPng(): Buffer {
    return encodePng(this.w, this.h, this.data);
  }
}
