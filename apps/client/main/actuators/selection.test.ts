/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — актуатор (взгляд/старт/снятие) с замоканными оверлеем и захватом экрана.
 *
 * Охраняет законы модуля: свежий кадр вместо памяти, честная ошибка вместо случайного куска экрана,
 * честное «снимать было нечего» вместо выдуманного действия, координатную систему кропа — и (после
 * адверс-ревью 2026-09-05) исходы, разведённые по виновнику: Esc владельца снимает прежнюю область,
 * таймаут/сбой окон её НЕ трогают, свежая область на start отдаётся без перерисовки.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureScreen = vi.fn(async () => ({
  image: "UE5H",
  mediaType: "image/png" as const,
  width: 640,
  height: 360,
  crop: { originX: 1200, originY: 400, scale: 1 },
}));
const perceptualHash = vi.fn(async () => ({ hash: "ffff", mean: 10, width: 8, height: 8 }));
vi.mock("./screen.js", () => ({ captureScreen, perceptualHash }));

const overlay = { drawing: false, start: vi.fn(), showFrame: vi.fn(), hideFrame: vi.fn(), hideAll: vi.fn() };
vi.mock("../selection/overlay.js", () => ({ selectionOverlay: overlay }));

const { selectionStart, selectionView, selectionClear, MAX_WAIT_MS, FRESH_MS, _resetSelectionActuatorForTest } = await import("./selection.js");
const { selectionStore, normalizeSelection } = await import("../selection/store.js");

const SEL = normalizeSelection({ x: 1200, y: 400, w: 640, h: 360, monitorIndex: 1, monitor: "Монитор 2", createdAt: Date.now() - 60_000 })!;

/** Промис, который «висит»: владелец ещё обводит. Оверлей при этом в фазе рисования. */
function pendingDraw(): Promise<never> {
  overlay.drawing = true;
  return new Promise(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  _resetSelectionActuatorForTest(); // pendingDraw прошлого кейса иначе «присоединял» бы новый start к мёртвому рисованию
  overlay.drawing = false;
  selectionStore.clear();
  selectionStore.setDrawing(false);
  captureScreen.mockResolvedValue({ image: "UE5H", mediaType: "image/png", width: 640, height: 360, crop: { originX: 1200, originY: 400, scale: 1 } });
  perceptualHash.mockResolvedValue({ hash: "ffff", mean: 10, width: 8, height: 8 });
});

describe("контроль-3: атрибуция отмены, вуаль при захвате, вид под вуалью, причина провала", () => {
  it("clear рукой владельца (хоткей/голос) гасит вуаль причиной esc → сервер скажет «Владелец закрыл»; системный/модельный — cleared", () => {
    overlay.drawing = true;
    selectionClear({ byOwner: true });
    expect(overlay.hideAll).toHaveBeenLastCalledWith("esc");
    overlay.drawing = true;
    selectionClear();
    expect(overlay.hideAll).toHaveBeenLastCalledWith("cleared");
  });

  it("view во время рисования бросает DrawingOverlayError (dispatch → overlay_drawing, петля не считает провалом модели)", async () => {
    selectionStore.set(SEL);
    overlay.drawing = true;
    await expect(selectionView()).rejects.toMatchObject({ name: "DrawingOverlayError" });
  });

  it("причина провала едет по факту: крах рендерера — «crashed», окна не создались — «no-windows»", async () => {
    overlay.start.mockResolvedValue({ failed: true, failReason: "crashed" });
    expect(await selectionStart(5000)).toMatchObject({ started: false, failed: true, failReason: "crashed" });
    _resetSelectionActuatorForTest();
    overlay.start.mockResolvedValue({ failed: true });
    expect(await selectionStart(5000)).toMatchObject({ started: false, failed: true, failReason: "no-windows" });
  });

  it("контроль-4: боевой крах — окна УЖЕ открыты (drawing=true), исход идёт через fromOutcome → failReason «crashed», waitedMs — число", async () => {
    overlay.drawing = true;
    overlay.start.mockResolvedValue({ failed: true, failReason: "crashed" });
    const r = await selectionStart(5000);
    expect(r).toMatchObject({ started: false, failed: true, failReason: "crashed" });
    expect(typeof r.waitedMs).toBe("number");
  });

  it("во время захвата отпечатка открылась НОВАЯ вуаль (force-start) → хеш не прикрепляется (иначе ложное «изменилось»)", async () => {
    overlay.start.mockResolvedValue({ selection: SEL });
    captureScreen.mockImplementation(async () => {
      overlay.drawing = true; // повторный хоткей открыл вуаль, пока мы снимали кадр области
      return { image: "UE5H", mediaType: "image/png", width: 640, height: 360, crop: { originX: 1200, originY: 400, scale: 1 } };
    });
    await selectionStart(5000);
    expect(selectionStore.get()?.hash).toBeUndefined();
    // Контроль: без вуали отпечаток прикрепляется — гард не выключил пробу перемен вовсе.
    _resetSelectionActuatorForTest();
    overlay.drawing = false;
    selectionStore.clear();
    captureScreen.mockResolvedValue({ image: "UE5H", mediaType: "image/png", width: 640, height: 360, crop: { originX: 1200, originY: 400, scale: 1 } });
    await selectionStart(5000);
    expect(selectionStore.get()?.hash).toBe("ffff");
  });
});

describe("selectionView", () => {
  it("во время рисования — честная ошибка «область ещё не зафиксирована», а не «ничего не выделял»", async () => {
    selectionStore.set(SEL);
    overlay.drawing = true;
    await expect(selectionView()).rejects.toThrow(/идёт рисование/u);
    expect(captureScreen).not.toHaveBeenCalled();
  });

  it("без выделения — ЧЕСТНАЯ ошибка, экран не снимается вовсе", async () => {
    await expect(selectionView()).rejects.toThrow(/ничего не выделял/u);
    expect(captureScreen).not.toHaveBeenCalled();
  });

  it("снимает СВЕЖИЙ кадр области по экранным координатам и отдаёт систему координат кропа", async () => {
    selectionStore.set(SEL);
    const r = await selectionView();
    expect(captureScreen).toHaveBeenCalledWith(1, expect.objectContaining({ rect: { x: 1200, y: 400, w: 640, h: 360, space: "screen" }, updateMapping: false }));
    expect(r.crop).toEqual({ originX: 1200, originY: 400, scale: 1 }); // без этого клик по увиденному невозможен
    expect(r.selection).toMatchObject({ w: 640, monitorIndex: 1 });
    expect(r.ageMs).not.toBeNull();
  });

  it("содержимое под рамкой сменилось — говорим об этом прямо; с лупой (scale) отпечаток НЕ сравниваем", async () => {
    selectionStore.set({ ...SEL, hash: "0000" });
    expect((await selectionView()).changedSinceSelection).toBe(true);
    selectionStore.clear();
    selectionStore.set(SEL);
    selectionStore.attachHash("ffff"); // так отпечаток и ставится в бою — после фиксации области
    expect((await selectionView()).changedSinceSelection).toBe(false);
    expect((await selectionView(2)).changedSinceSelection).toBeUndefined(); // ресемплинг переворачивает биты хеша
  });
});

describe("selectionClear", () => {
  it("три исхода: рамка снята / закрыт режим рисования / снимать было нечего", () => {
    expect(selectionClear()).toEqual({ cleared: false, drawCancelled: false });
    selectionStore.set(SEL);
    expect(selectionClear()).toEqual({ cleared: true, drawCancelled: false });
    overlay.drawing = true; // вуаль на экране, области ещё нет
    expect(selectionClear()).toEqual({ cleared: false, drawCancelled: true });
    expect(overlay.hideAll).toHaveBeenCalledWith("cleared");
  });
});

describe("selectionStart", () => {
  it("без waitMs возвращается сразу — голосовой ack не ждёт владельца", async () => {
    overlay.start.mockImplementation(pendingDraw);
    expect(await selectionStart()).toEqual({ started: true, waiting: true });
  });

  it("ожидание клампится потолком схемы и называет ФАКТИЧЕСКИ прождённое время", async () => {
    vi.useFakeTimers();
    overlay.start.mockImplementation(pendingDraw);
    const p = selectionStart(10 * 60_000); // просили 10 минут
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 10);
    // Контроль-5 (SEL-C5-4): без клампа промис висел бы до 10 минут, и кейс валился ТАЙМАУТОМ раннера, а не ассертом.
    expect(settled).toBe(true);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(MAX_WAIT_MS);
  });

  it("владелец обвёл — область запомнена, рамка показана, отпечаток снят", async () => {
    overlay.start.mockResolvedValue({ selection: SEL });
    const r = await selectionStart(5000);
    expect(r.selection).toMatchObject({ w: 640 });
    expect(overlay.showFrame).toHaveBeenCalledWith(SEL);
    expect(selectionStore.get()?.hash).toBe("ffff");
  });

  it("владелец передумал (Esc) — прежнее выделение СНИМАЕТСЯ: это его решение выйти из режима", async () => {
    selectionStore.set(SEL);
    overlay.start.mockResolvedValue({ cancelled: true, reason: "esc" });
    const r = await selectionStart(5000);
    expect(r).toMatchObject({ started: true, cancelled: true });
    expect(selectionStore.get()).toBeNull();
    expect(overlay.hideFrame).toHaveBeenCalled();
  });

  it("таймаут вуали — СИСТЕМА закрыла оверлей: overlayOpen=false, прежнее выделение остаётся, владельцу ничего не приписываем", async () => {
    selectionStore.set(SEL);
    overlay.start.mockResolvedValue({ cancelled: true, reason: "timeout" });
    const r = await selectionStart(5000);
    expect(r).toMatchObject({ started: true, timedOut: true, overlayOpen: false, cancelReason: "timeout" });
    expect(r.cancelled).toBeUndefined();
    expect(selectionStore.get()).toMatchObject({ w: 640 });
  });

  it("рисование прервано командой снятия (reason: cleared) → cancelReason «cleared», не «owner»", async () => {
    overlay.start.mockResolvedValue({ cancelled: true, reason: "cleared" });
    const r = await selectionStart(5000);
    expect(r).toMatchObject({ started: true, cancelled: true, cancelReason: "cleared" });
  });

  it("ожидание истекло, вуаль ещё на экране → overlayOpen=true", async () => {
    vi.useFakeTimers();
    overlay.start.mockImplementation(pendingDraw);
    const p = selectionStart(1000);
    await vi.advanceTimersByTimeAsync(1010);
    expect(await p).toMatchObject({ timedOut: true, overlayOpen: true });
  });

  it("два start на одном рисовании применяют исход ОДИН раз (рамка, захват, отпечаток — по разу)", async () => {
    let resolveDraw!: (o: unknown) => void;
    overlay.drawing = true;
    overlay.start.mockImplementation(() => new Promise((r) => (resolveDraw = r)));
    const a = selectionStart(5000);
    const b = selectionStart(5000);
    expect(overlay.start).toHaveBeenCalledTimes(1); // второй присоединился, окна не трогал
    overlay.drawing = false;
    resolveDraw({ selection: SEL });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.selection).toMatchObject({ w: 640 });
    expect(rb.selection).toMatchObject({ w: 640 });
    expect(overlay.showFrame).toHaveBeenCalledTimes(1);
    expect(captureScreen).toHaveBeenCalledTimes(1);
  });

  it("обвёл за миг до дедлайна, пока шёл захват отпечатка → ответ несёт область, а не «не обвёл»", async () => {
    vi.useFakeTimers();
    overlay.drawing = true;
    overlay.start.mockImplementation(() => new Promise((r) => setTimeout(() => r({ selection: SEL }), 990)));
    captureScreen.mockImplementation(() => new Promise((r) => setTimeout(() => r({ image: "UE5H", mediaType: "image/png", width: 640, height: 360, crop: { originX: 1200, originY: 400, scale: 1 } }), 60)));
    const p = selectionStart(1000);
    await vi.advanceTimersByTimeAsync(1200);
    const r = await p;
    expect(r.selection).toMatchObject({ w: 640 });
    expect(r.timedOut).toBeUndefined();
  });

  it("окна оверлея не открылись — честный failed, не «обводите область» и не «владелец отменил»", async () => {
    selectionStore.set(SEL);
    overlay.start.mockResolvedValue({ failed: true }); // drawing остаётся false — start завершился сразу
    expect(await selectionStart()).toEqual({ started: false, failed: true, failReason: "no-windows" });
    expect(selectionStore.get()).toMatchObject({ w: 640 }); // прежняя область цела
  });

  it("выделение моложе FRESH_MS на МОДЕЛЬНЫЙ start — отдаём его, оверлей не перезапускаем (гонка «сказал и обвёл»)", async () => {
    selectionStore.set({ ...SEL, createdAt: Date.now() - Math.floor(FRESH_MS / 2) });
    const r = await selectionStart(5000);
    expect(r).toMatchObject({ started: false, reused: true });
    expect(r.selection).toMatchObject({ w: 640 });
    expect(overlay.start).not.toHaveBeenCalled();
  });

  it("хоткей/голос (force) рисуют ВСЕГДА — владелец вправе перерисовать только что обведённое", async () => {
    selectionStore.set({ ...SEL, createdAt: Date.now() - Math.floor(FRESH_MS / 2) });
    overlay.start.mockImplementation(pendingDraw);
    expect(await selectionStart(0, { force: true })).toEqual({ started: true, waiting: true });
    expect(overlay.start).toHaveBeenCalledTimes(1);
  });
});
