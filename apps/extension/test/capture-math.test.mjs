// Арифметика снимка вкладки (tab.capture): кроп в физических пикселях, масштаб и потолок картинки.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planCapture, pngSize } from "../modules/capture-math.js";

// Потолок — литералом (контракт W1 §1), не из модуля: иначе поломка константы прошла бы незамеченной.
const MAX_SIDE = 1568;
const MAX_PIXELS = 1_150_000;

describe("planCapture", () => {
  it("весь вьюпорт: ужат до 1568 по длинной стороне и 1,15 Мп, пропорции целы", () => {
    const p = planCapture({ imgW: 2560, imgH: 1440, viewW: 1280, viewH: 720 });
    assert.ok(Math.max(p.outW, p.outH) <= MAX_SIDE && p.outW * p.outH <= MAX_PIXELS, JSON.stringify(p));
    assert.ok(Math.abs(p.outW / p.outH - 2560 / 1440) < 0.01);
    assert.deepEqual([p.sx, p.sy, p.sw, p.sh, p.dpr], [0, 0, 2560, 1440, 2]);
    assert.deepEqual(p.cssRect, { x: 0, y: 0, w: 1280, h: 720 });
  });

  it("маленький вьюпорт без rect не растягивается (identity)", () => {
    const p = planCapture({ imgW: 800, imgH: 600, viewW: 800, viewH: 600 });
    assert.deepEqual([p.outW, p.outH, p.identity], [800, 600, true]);
  });

  it("rect — кроп в ФИЗИЧЕСКИХ пикселях (×dpr), по умолчанию ×2", () => {
    const p = planCapture({ imgW: 2560, imgH: 1440, viewW: 1280, viewH: 720, rect: { x: 100, y: 50, w: 200, h: 100 } });
    assert.deepEqual([p.sx, p.sy, p.sw, p.sh], [200, 100, 400, 200]);
    assert.deepEqual([p.outW, p.outH], [800, 400]);
  });

  it("крупный кроп вписывается в 1568 и 1,15 Мп, а не удваивается", () => {
    const p = planCapture({ imgW: 1280, imgH: 720, viewW: 1280, viewH: 720, rect: { x: 0, y: 0, w: 1200, h: 700 } });
    assert.ok(Math.max(p.outW, p.outH) <= MAX_SIDE && p.outW * p.outH <= MAX_PIXELS, JSON.stringify(p));
  });

  it("явный scale: меньше — уменьшает, больше потолка — упирается в потолок", () => {
    const r = { x: 0, y: 0, w: 400, h: 200 };
    const half = planCapture({ imgW: 1280, imgH: 720, viewW: 1280, viewH: 720, rect: r, scale: 0.5 });
    assert.deepEqual([half.outW, half.outH], [200, 100]);
    const huge = planCapture({ imgW: 1280, imgH: 720, viewW: 1280, viewH: 720, rect: r, scale: 10 });
    assert.deepEqual([huge.outW, huge.outH], [800, 400]); // не больше ×2
  });

  it("rect частично за краем — обрезается по вьюпорту; целиком вне — честная ошибка", () => {
    const p = planCapture({ imgW: 1000, imgH: 800, viewW: 1000, viewH: 800, rect: { x: 900, y: -50, w: 300, h: 150 } });
    assert.deepEqual(p.cssRect, { x: 900, y: 0, w: 100, h: 100 });
    assert.deepEqual([p.sx, p.sy, p.sw, p.sh], [900, 0, 100, 100]);
    assert.ok(planCapture({ imgW: 1000, imgH: 800, viewW: 1000, viewH: 800, rect: { x: 1200, y: 10, w: 50, h: 50 } }).error);
  });
});

describe("planCapture — один масштаб на обе оси (W1-T7)", () => {
  it("высота снимка не сходится с вьюпортом (> 2 px) — честная ошибка, а не растянутый кроп", () => {
    const p = planCapture({ imgW: 800, imgH: 624, viewW: 800, viewH: 600, rect: { x: 40, y: 30, w: 100, h: 50 } });
    assert.ok(p.error, JSON.stringify(p));
    assert.ok(planCapture({ imgW: 800, imgH: 624, viewW: 800, viewH: 600 }).error);
  });

  it("расхождение в пределах округления (≤ 2 px) — кроп по ОДНОМУ масштабу ширины", () => {
    // По высоте масштаб был бы 1202/600 ≈ 2,0033 → sy = 1002: кроп «поехал» бы вниз.
    const p = planCapture({ imgW: 1600, imgH: 1202, viewW: 800, viewH: 600, rect: { x: 40, y: 500, w: 100, h: 90 } });
    assert.deepEqual([p.sx, p.sy, p.sw, p.sh, p.dpr], [80, 1000, 200, 180, 2]);
  });
});

describe("pngSize", () => {
  it("размер из заголовка IHDR; не PNG — null", () => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(2560, 16);
    b.writeUInt32BE(1440, 20);
    assert.deepEqual(pngSize("data:image/png;base64," + b.toString("base64")), { width: 2560, height: 1440 });
    assert.equal(pngSize("data:image/jpeg;base64,AAAA"), null);
  });
});
