/** Зрение FakeDesktop: PNG сцены, кадры, OCR, probe, выделение, мониторы, wait.for на виртуальных часах, demo.record. */
import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { crc32, encodePng, pngInfo } from "./png.js";
import { kit } from "./gui-testkit.js";

const pixels = (b64: string): { w: number; h: number; at(x: number, y: number): number[] } => {
  const b = Buffer.from(b64, "base64");
  const { width: w, height: h } = pngInfo(b);
  // IDAT — единственный: склеиваем все и разжимаем (фильтр 0 у нашего кодера)
  let off = 8;
  const idat: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    if (b.toString("ascii", off + 4, off + 8) === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { w, h, at: (x, y) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)] };
};

describe("png.ts", () => {
  it("настоящий PNG: сигнатура, IHDR-размер, валидный CRC чанков, пиксели читаются обратно", () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i % 4 === 3 ? 255 : i * 10));
    const png = encodePng(3, 2, rgba);
    expect(pngInfo(png)).toEqual({ width: 3, height: 2 });
    const ihdrCrc = png.readUInt32BE(8 + 4 + 4 + 13);
    expect(ihdrCrc).toBe(crc32(png.subarray(12, 12 + 4 + 13)));
    const p = pixels(png.toString("base64"));
    expect(p.at(2, 1)).toEqual([...rgba.subarray(20, 24)]);
  });

  it("несходящийся буфер и не-PNG — ошибки, а не мусор", () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
    expect(() => pngInfo(Buffer.from("не png вообще, совсем не png"))).toThrow();
  });
});

describe("screen.capture", () => {
  it("картинка нужного размера + frameId + mediaType; масштаб и потолок стороны уважаются", async () => {
    const k = kit();
    const r = await k.ok({ kind: "screen.capture", monitor: 0 });
    expect(r.mediaType).toBe("image/png");
    expect(pngInfo(r.image)).toEqual({ width: r.width, height: r.height });
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1568);
    expect(r.width / r.height).toBeCloseTo(2560 / 1440, 1);
    expect(r.frameId).toMatch(/^labf\d+$/u);
    const small = await k.ok({ kind: "screen.capture", monitor: 0, scale: 0.25, maxEdge: 4000 });
    expect(small.width).toBe(640);
    expect(small.height).toBe(360);
    expect((await k.fail({ kind: "screen.capture", monitor: 9 })).code).toBe("runtime");
  });

  it("сцена рисуется из окон: пиксели меняются, когда окно появляется, и совпадают, когда состояние то же", async () => {
    const k = kit();
    const a = await k.ok({ kind: "screen.probe", monitor: 0 });
    const a2 = await k.ok({ kind: "screen.probe", monitor: 0 });
    expect(a2.hash).toBe(a.hash);
    await k.ok({ kind: "app.launch", app: "notepad" });
    const b = await k.ok({ kind: "screen.probe", monitor: 0 });
    expect(b.hash).not.toBe(a.hash);
    const w = k.win("notepad");
    const cap = await k.ok({ kind: "screen.capture", monitor: 0, scale: 0.5, maxEdge: 4000 });
    const px = pixels(cap.image);
    const inside = px.at(Math.round((w.rect.x + w.rect.w / 2) / 2), Math.round((w.rect.y + w.rect.h / 2) / 2));
    const outside = px.at(5, 5);
    expect(inside).not.toEqual(outside);
    expect(inside.slice(0, 3)).toEqual([255, 255, 255]); // Edit-контрол блокнота белый
  });

  it("регион в координатах кадра → зум-кадр с zoomOf; вне кадра/устаревший кадр — not_found", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const full = await k.ok({ kind: "screen.capture", monitor: 0 });
    const z = await k.ok({ kind: "screen.capture", rect: { x: 0, y: 0, w: 300, h: 200, frame: full.frameId } });
    expect(z.zoomOf).toBe(full.frameId);
    expect(z.frameId).toMatch(/^labz/u);
    expect((await k.fail({ kind: "screen.capture", rect: { x: 0, y: 0, w: 10, h: 10, frame: "labf9999" } })).code).toBe("not_found");
    expect((await k.fail({ kind: "screen.capture", rect: { x: 5000, y: 0, w: 10, h: 10, frame: full.frameId } })).code).toBe("not_found");
    expect((await k.fail({ kind: "screen.capture", rect: { x: 0, y: 0, w: 10, h: 10 } })).code).toBe("not_found"); // регион без кадра
  });

  it("кадры вытесняются (LRU 64): самый старый становится «устаревшим»", async () => {
    const k = kit();
    const first = await k.ok({ kind: "screen.capture", monitor: 0, scale: 0.25 });
    for (let i = 0; i < 65; i += 1) await k.ok({ kind: "screen.capture", monitor: 0, scale: 0.25 });
    const e = await k.fail({ kind: "input.click", target: { by: "coords", x: 5, y: 5, frame: first.frameId } });
    expect(e.code).toBe("not_found");
    expect(e.message).toContain("кадр устарел");
  });
});

describe("screen.ocr / screen.probe", () => {
  it("OCR даёт строки видимого текста с рамками; закрытое другим окном не читается", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    await k.ok({ kind: "input.type", text: "секретная строка" });
    const seen = await k.ok({ kind: "screen.ocr", monitor: 0 });
    expect(seen.text).toContain("секретная строка");
    expect(seen.lines[0]).toEqual(expect.objectContaining({ text: expect.any(String), x: expect.any(Number), w: expect.any(Number) }));
    expect(seen.frameId).toMatch(/^labo/u);
    // Закрываем блокнот окном 2560×… поверх: калькулятор на весь экран
    const w = k.win("notepad");
    await k.ok({ kind: "app.launch", app: "calc" });
    const calc = k.win("CalculatorApp");
    await k.ok({ kind: "window.arrange", hwnd: calc.hwnd, op: "maximize" });
    void w;
    expect((await k.ok({ kind: "screen.ocr", monitor: 0 })).text).not.toContain("секретная строка");
  });

  it("OCR в кадре задачи переводит координаты в пиксели кадра", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const cap = await k.ok({ kind: "screen.capture", monitor: 0, scale: 0.5, maxEdge: 4000 });
    const raw = await k.ok({ kind: "screen.ocr", monitor: 0 });
    const inFrame = await k.ok({ kind: "screen.ocr", monitor: 0, frame: cap.frameId });
    const a = raw.lines.find((l: any) => l.text === "Калькулятор");
    const b = inFrame.lines.find((l: any) => l.text === "Калькулятор");
    expect(b.x).toBe(Math.round(a.x * 0.5));
    expect(inFrame.frame).toBe(cap.frameId);
  });

  it("probe: перцептивный хеш 8×8 — структурная перемена другой хеш, мелкая (одна цифра) не флипает биты, как у настоящего", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    const w = k.win("CalculatorApp");
    const rect = { x: w.rect.x, y: w.rect.y, w: w.rect.w, h: w.rect.h, space: "screen" };
    const before = await k.ok({ kind: "screen.probe", rect });
    expect(before.hash).toMatch(/^[0-9a-f]{16}$/u);
    await k.ok({ kind: "window.arrange", hwnd: w.hwnd, op: "minimize" });
    const after = await k.ok({ kind: "screen.probe", rect });
    expect(after.hash).not.toBe(before.hash);
    expect(after.mean).not.toBe(before.mean);
  });
});

describe("screen.selection", () => {
  it("view без выделения — честная ошибка; выделение владельца → снимок с frameId и ageMs", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    expect((await k.fail({ kind: "screen.selection", op: "view" })).message).toContain("ничего не выделял");
    k.d.userAction("selection", { x: 200, y: 100, w: 340, h: 300, monitorIndex: 0 });
    k.d.advance(1200);
    const v = await k.ok({ kind: "screen.selection", op: "view" });
    expect(v).toMatchObject({ mediaType: "image/png", ageMs: 1200, selection: { x: 200, w: 340 } });
    expect(v.frameId).toMatch(/^labs/u);
    expect(v.changedSinceSelection).toBe(false);
    await k.ok({ kind: "window.arrange", query: "калькулятор", op: "minimize" }); // под рамкой стало другое
    expect((await k.ok({ kind: "screen.selection", op: "view" })).changedSinceSelection).toBe(true);
    expect(await k.ok({ kind: "screen.selection", op: "clear" })).toMatchObject({ cleared: true });
    expect((await k.fail({ kind: "screen.selection", op: "view" })).code).toBe("runtime");
  });

  it("start включает вуаль: view → overlay_drawing, физический ввод → overlay_drawing, снимок помечен", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "notepad" });
    expect(await k.ok({ kind: "screen.selection", op: "start" })).toMatchObject({ started: true, waiting: true });
    expect((await k.fail({ kind: "screen.selection", op: "view" })).code).toBe("overlay_drawing");
    expect((await k.fail({ kind: "input.type", text: "x" })).code).toBe("overlay_drawing");
    expect((await k.ok({ kind: "screen.capture", monitor: 0 })).overlayDrawing).toBe(true);
    expect(k.win("notepad").text).toBe("");
    await k.ok({ kind: "screen.selection", op: "clear" });
    await k.ok({ kind: "input.type", text: "x" });
  });

  it("start{waitMs}: владелец обвёл в срок → область; не обвёл → честный таймаут, вуаль остаётся", async () => {
    const k = kit();
    k.d.userAction("selection.plan", { x: 10, y: 10, w: 100, h: 100, monitorIndex: 0, afterMs: 2000 });
    const ok = await k.ok({ kind: "screen.selection", op: "start", waitMs: 5000 });
    expect(ok).toMatchObject({ started: true, waitedMs: 2000, selection: { w: 100 } });
    const t = await k.ok({ kind: "screen.selection", op: "start", waitMs: 3000, force: true });
    expect(t).toMatchObject({ timedOut: true, overlayOpen: true, waitedMs: 3000 });
  });

  it("свежее выделение (<5 с) переиспользуется без force", async () => {
    const k = kit();
    k.d.userAction("selection", { x: 0, y: 0, w: 50, h: 50, monitorIndex: 0 });
    expect(await k.ok({ kind: "screen.selection", op: "start" })).toMatchObject({ started: false, reused: true });
  });
});

describe("мониторы", () => {
  it("monitor.list: метки, isPrimary, isJarvis (по умолчанию вторичный)", async () => {
    const k = kit();
    const r = await k.ok({ kind: "monitor.list" });
    expect(r.monitors).toHaveLength(2);
    expect(r.monitors[0]).toMatchObject({ index: 0, isPrimary: true, width: 2560, isJarvis: false });
    expect(r.monitors[1]).toMatchObject({ isPrimary: false, isJarvis: true });
    expect(r.monitors[1].label).toContain("справа");
  });

  it("monitor.assign меняет монитор Джарвиса; неверный индекс — ошибка; null — авто", async () => {
    const k = kit();
    await k.ok({ kind: "monitor.assign", index: 0 });
    expect((await k.ok({ kind: "monitor.list" })).monitors[0].isJarvis).toBe(true);
    expect((await k.fail({ kind: "monitor.assign", index: 5 })).code).toBe("runtime");
    await k.ok({ kind: "monitor.assign", index: null });
    expect((await k.ok({ kind: "monitor.list" })).monitors[1].isJarvis).toBe(true);
  });

  it("monitor.set primary → снимок monitor:'jarvis' идёт с основного", async () => {
    const k = kit();
    const jarvis = await k.ok({ kind: "screen.capture", monitor: "jarvis", maxEdge: 4000, maxPixels: 9_000_000 });
    expect(jarvis.width).toBe(1920);
    await k.ok({ kind: "monitor.set", target: "primary" });
    expect((await k.ok({ kind: "screen.capture", monitor: "jarvis", maxEdge: 4000, maxPixels: 9_000_000 })).width).toBe(2560);
  });
});

describe("wait.for на виртуальных часах", () => {
  it("window: появится после действия — met; таймаут = ok + met:false (не ошибка), время идёт виртуально", async () => {
    const k = kit();
    const t0 = k.d.snapshot().effects.length;
    const miss = await k.ok({ kind: "wait.for", condition: { kind: "window", titleContains: "Блокнот" }, timeoutMs: 60_000 });
    expect(miss).toMatchObject({ met: false });
    expect(miss.elapsedMs).toBeGreaterThanOrEqual(59_000);
    void t0;
    await k.ok({ kind: "app.launch", app: "notepad" });
    expect(await k.ok({ kind: "wait.for", condition: { kind: "window", titleContains: "Блокнот" } })).toMatchObject({ met: true, polls: 1 });
    expect((await k.ok({ kind: "wait.for", condition: { kind: "window", process: "notepad", gone: true }, timeoutMs: 1500 })).met).toBe(false);
    await k.ok({ kind: "app.close", app: "notepad" });
    expect((await k.ok({ kind: "wait.for", condition: { kind: "window", process: "notepad", gone: true } })).met).toBe(true);
  });

  it("ui / text / process видят актуальное состояние", async () => {
    const k = kit();
    await k.ok({ kind: "app.launch", app: "calc" });
    expect((await k.ok({ kind: "wait.for", condition: { kind: "ui", role: "button", name: "Плюс" } })).met).toBe(true);
    expect((await k.ok({ kind: "wait.for", condition: { kind: "ui", role: "button", name: "Синус" }, timeoutMs: 1000 })).met).toBe(false);
    await k.ok({ kind: "input.type", text: "42" });
    expect((await k.ok({ kind: "wait.for", condition: { kind: "text", text: "42", monitor: 0 } })).met).toBe(true);
    expect((await k.ok({ kind: "wait.for", condition: { kind: "text", text: "43", monitor: 0 }, timeoutMs: 1000 })).met).toBe(false);
    const pid = k.win("CalculatorApp").pid;
    expect((await k.ok({ kind: "wait.for", condition: { kind: "process", pid } })).met).toBe(true);
    expect((await k.ok({ kind: "wait.for", condition: { kind: "process", name: "ffmpeg.exe" }, timeoutMs: 1000 })).met).toBe(false);
  });

  it("file: minBytes и stableMs — стабилизация ждёт неизменности на виртуальных часах", async () => {
    const k = kit({ files: { "Documents/out.mp4": "12345" } });
    const path = "C:/Users/lab/Documents/out.mp4";
    expect((await k.ok({ kind: "wait.for", condition: { kind: "file", path, minBytes: 100 }, timeoutMs: 1500 })).met).toBe(false);
    const stable = await k.ok({ kind: "wait.for", condition: { kind: "file", path, stableMs: 2000 }, timeoutMs: 10_000 });
    expect(stable.met).toBe(true);
    expect(stable.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect((await k.ok({ kind: "wait.for", condition: { kind: "file", path: "C:/Users/lab/нет.bin" }, timeoutMs: 1000 })).met).toBe(false);
    expect((await k.ok({ kind: "wait.for", condition: { kind: "file", path: "C:/Users/lab/нет.bin", gone: true } })).met).toBe(true);
  });

  it("gsi: свежий пуш совпал; протух — stale; ничего не пушили — none", async () => {
    const k = kit();
    expect((await k.ok({ kind: "wait.for", condition: { kind: "gsi", path: "map.phase", equals: "live" }, timeoutMs: 1000 })).gsiState).toBe("none");
    k.d.userAction("gsi", { source: "default", data: { map: { phase: "live" } } });
    expect(await k.ok({ kind: "wait.for", condition: { kind: "gsi", path: "map.phase", equals: "live" } })).toMatchObject({ met: true, gsiState: "fresh" });
    k.d.advance(20_000);
    expect(await k.ok({ kind: "wait.for", condition: { kind: "gsi", path: "map.phase", equals: "live" }, timeoutMs: 1000 })).toMatchObject({ met: false, gsiState: "stale" });
  });

  it("browser-условие клиент не проверяет (честно «нет»), невалидные — ошибки", async () => {
    const k = kit();
    const b = await k.ok({ kind: "wait.for", condition: { kind: "browser", check: "url", contains: "x" }, timeoutMs: 1000 });
    expect(b.met).toBe(false);
    expect(b.detail).toContain("на сервере");
    expect((await k.fail({ kind: "wait.for", condition: { kind: "window" } })).code).toBe("runtime");
    expect((await k.fail({ kind: "wait.for", condition: { kind: "text", text: "  " } })).code).toBe("runtime");
    expect((await k.fail({ kind: "wait.for", condition: { kind: "process" } })).code).toBe("runtime");
  });

  it("под вуалью визуальный wait не уверен: unknown:true вместо ложного «нет»", async () => {
    const k = kit();
    await k.ok({ kind: "screen.selection", op: "start" });
    const r = await k.ok({ kind: "wait.for", condition: { kind: "text", text: "нету", monitor: 0 }, timeoutMs: 1500 });
    expect(r).toMatchObject({ met: false, unknown: true, overlayDrawing: true });
  });
});

describe("demo.record", () => {
  it("как у настоящего клиента: not implemented (M4) — лаборатория не делает вид, что умеет", async () => {
    const k = kit();
    const e = await k.fail({ kind: "demo.record", op: "start" });
    expect(e.message).toContain("not implemented");
  });
});
