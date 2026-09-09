/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ (2026-09-03) — операции над областью, которую владелец обвёл на экране.
 *
 * Зачем: голос — узкий канал, и «вот тут недочёт» без указателя не работает. Владелец обводит кусок
 * экрана (хоткеем или голосом), рамка висит, а дальше он говорит о нём дейксисом.
 *
 * ТРИ ЗАКОНА ЭТОГО МОДУЛЯ:
 *  1. Взгляд — ВСЕГДА СВЕЖИЙ КАДР области, а не картинка, снятая в момент выделения: «я это видел»
 *     про экран минутной давности — ровно тот ложный успех, который проект не прощает.
 *  2. Выделения нет → ЧЕСТНАЯ ошибка («владелец ничего не выделял»), а не случайный кусок экрана.
 *  3. Содержимое области могло смениться с момента выделения (окно закрыли, проскроллили) — считаем
 *     отпечаток и говорим об этом прямо, чтобы модель не выдавала старое намерение за новое.
 *
 * АДВЕРС-РЕВЬЮ 2026-09-05: исходы рисования разведены по ВИНОВНИКУ. Esc/клик без протяжки — решение
 * владельца («выключить режим» — снимаем и прежнюю рамку); таймаут/сбой окон — система, прежнее
 * выделение НЕ трогаем и владельцу ничего не приписываем. Свежее выделение (моложе FRESH_MS) на
 * `start` не перерисовывается: это гонка «сказал „вот тут" и одновременно обвёл» — модель просто
 * получает то, что уже обведено.
 */
import { createLogger } from "@jarvis/shared";
import { SELECTION_MAX_WAIT_MS, type ScreenSelection } from "@jarvis/protocol";
import { captureScreen, perceptualHash } from "./screen.js";
import { DrawingOverlayError, releaseHeldPointer } from "./input.js";
import { selectionStore } from "../selection/store.js";
import { type CancelReason, selectionOverlay } from "../selection/overlay.js";

const log = createLogger("actuator:selection");

// Контроль-9 (mouse-up-terminates-owner-drawing): пока вуаль на экране, `input.mouse{op:"up"}` не пропускается (он
// завершил бы выделение владельца в точке курсора). Значит отпустить зажатое обязаны МЫ — ровно в момент закрытия
// вуали, а не через watchdog сайдкара 15 с.
selectionStore.onDrawingChange((on) => {
  if (!on) void releaseHeldPointer();
});

/** Кто закрыл рисование без области: рука владельца / таймер вуали / команда снятия (или смена мониторов). */
export type SelectionCancelReason = "owner" | "timeout" | "cleared";

export interface SelectionStartResult {
  started: boolean;
  selection?: ScreenSelection;
  /** Рисование закрылось без области. cancelReason говорит, КТО закрыл — владельцу чужие действия не приписываем. */
  cancelled?: boolean;
  cancelReason?: SelectionCancelReason;
  /** Ждали заданное окно, владелец ещё не обвёл. overlayOpen — правда ли вуаль ещё на экране. */
  timedOut?: boolean;
  overlayOpen?: boolean;
  /** Сколько реально прождали (мс) — чтобы «не обвёл за N» называло правдивое N. */
  waitedMs?: number;
  /** waitMs не задан: вернулись сразу, не дожидаясь владельца. */
  waiting?: boolean;
  /** Окна оверлея не открылись / упали — сбой системы, не действие владельца. */
  failed?: boolean;
  /** Чем именно не удалось: окна не создались вовсе / открылись, но рендерер упал (текст серверу — по факту). */
  failReason?: "no-windows" | "crashed";
  /** Выделение уже было свежим — оверлей не открывали, отдали его как есть. */
  reused?: boolean;
}

export interface SelectionViewResult {
  image: string;
  mediaType: "image/png";
  width: number;
  height: number;
  selection: ScreenSelection;
  /** Сколько прошло с момента, когда владелец обвёл область (мс) — null, если время неизвестно. */
  ageMs: number | null;
  /** Содержимое области отличается от того, что было при выделении (перцептивный хеш, только без scale). */
  changedSinceSelection?: boolean;
  /**
   * Система координат ЭТОГО кадра: screenX = originX + x/scale. Без неё взгляд был бы ТУПИКОМ — увидеть
   * мелкий дефект крупно можно, а кликнуть по увиденному нельзя (клики считаются от последнего ПОЛНОГО
   * снимка, а кроп его намеренно не сбивает). Та же грабля, что чинили для «лупы» screen_capture.
   */
  crop?: { originX: number; originY: number; scale: number };
}

/** Потолок ожидания владельца — совпадает со схемой инструмента (maximum: 120000); сервер ждёт waitMs+15 с. */
export const MAX_WAIT_MS = SELECTION_MAX_WAIT_MS;
/** Выделение моложе этого на `start` не перерисовываем — это то самое «сказал и одновременно обвёл». */
export const FRESH_MS = 15_000;

/**
 * ОДНО рисование — ОДНО применение исхода: хоткей и модельный start, присоединившиеся к одной вуали,
 * делят этот промис (иначе рамка создавалась и уничтожалась дважды, а захват с хешем шёл повторно).
 */
let inflight: { outcome: Promise<OverlayOutcome>; applied: Promise<OverlayOutcome>; settled: () => boolean } | null = null;

type OverlayOutcome = { selection?: ScreenSelection; cancelled?: boolean; reason?: CancelReason; failed?: boolean; failReason?: "no-windows" | "crashed" };

/** ТОЛЬКО для тестов: замоканный оверлей может оставить «вечное» рисование, в бою inflight гасится сам. */
export function _resetSelectionActuatorForTest(): void {
  inflight = null;
}

function beginDraw(): NonNullable<typeof inflight> {
  if (inflight && selectionOverlay.drawing) return inflight;
  const outcome = selectionOverlay.start();
  let settled = false;
  const applied = outcome.then(async (o) => {
    settled = true;
    await applyOutcome(o);
    return o;
  });
  const flight = { outcome, applied, settled: () => settled };
  inflight = flight;
  void applied.catch(() => undefined).finally(() => {
    if (inflight === flight) inflight = null;
  });
  return flight;
}

/** Исход оверлея → результат для сервера: причина закрытия названа честно, по виновнику. */
function fromOutcome(o: OverlayOutcome, waitedMs: number): SelectionStartResult {
  if (o.failed) return { started: false, failed: true, failReason: o.failReason ?? "no-windows", waitedMs };
  if (o.selection) return { started: true, selection: o.selection, waitedMs };
  if (o.reason === "timeout") return { started: true, timedOut: true, overlayOpen: false, cancelReason: "timeout", waitedMs };
  if (o.reason === "esc") return { started: true, cancelled: true, cancelReason: "owner", waitedMs };
  return { started: true, cancelled: true, cancelReason: "cleared", waitedMs }; // cleared / quit — не владелец
}

/** Принять исход оверлея: запомнить область, оставить рамку, снять отпечаток содержимого. */
async function applyOutcome(o: { selection?: ScreenSelection; cancelled?: boolean; reason?: CancelReason; failed?: boolean }): Promise<void> {
  if (o.selection) {
    selectionStore.set(o.selection);
    selectionOverlay.showFrame(o.selection);
    // Контроль-3: force-start (повторный хоткей) мог открыть НОВУЮ вуаль, пока мы снимали отпечаток —
    // хеш затемнённого кадра на чистом экране читался бы как «содержимое ИЗМЕНИЛОСЬ». Под вуалью
    // отпечаток не прикрепляем: честнее «проба не проводилась», чем ложные перемены.
    const veiledBefore = selectionOverlay.drawing;
    try {
      const shot = await captureScreen(o.selection.monitorIndex, {
        rect: { x: o.selection.x, y: o.selection.y, w: o.selection.w, h: o.selection.h, space: "screen" },
        updateMapping: false,
      });
      const probe = await perceptualHash(shot.image, shot.width, shot.height);
      const same = selectionStore.get()?.createdAt === o.selection.createdAt;
      if (same && !veiledBefore && !selectionOverlay.drawing) selectionStore.attachHash(probe.hash);
      else if (same) log.info("отпечаток области не прикреплён: во время захвата была открыта вуаль нового рисования");
    } catch (e) {
      // Отпечаток — удобство, а не условие: без него просто не сможем сказать «содержимое изменилось».
      log.warn("отпечаток области не снят", e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (o.failed || o.reason === "timeout" || o.reason === "quit") {
    // Система не дала владельцу обвести (окна не открылись / он не подошёл к мыши): прежняя область
    // остаётся его последним указанием — трогать её и приписывать ему «отменил» нельзя.
    return;
  }
  // Отмена рукой владельца (Esc / клик без протяжки) = «режим выключить»: снимаем и прежнюю область.
  // Иначе выключить выделение с клавиатуры было бы НЕЧЕМ, а висящая рамка врала бы, что он на неё показывает.
  selectionStore.clear();
  selectionOverlay.hideFrame();
}

/**
 * Открыть оверлей и дать владельцу обвести область.
 * waitMs > 0 — дождаться исхода (и вернуть его модели); иначе вернуться сразу (голосовой путь: ack
 * звучит мгновенно, а выделение приедет на сервер отдельным сообщением client.selection).
 */
export async function selectionStart(waitMs?: number, opts?: { force?: boolean }): Promise<SelectionStartResult> {
  const fresh = selectionStore.get();
  const age = selectionStore.ageMs(Date.now());
  // Свежую область НЕ перерисовываем только для МОДЕЛЬНОГО start (гонка «сказал „вот тут" и одновременно
  // обвёл»). Хоткей и голосовая команда — явная воля владельца перерисовать: force, оверлей открывается всегда.
  if (!opts?.force && fresh && age !== null && age < FRESH_MS && !selectionOverlay.drawing) {
    return { started: false, reused: true, selection: fresh }; // уже обвёл — перерисовывать нечего
  }
  const wait = typeof waitMs === "number" && Number.isFinite(waitMs) ? Math.max(0, Math.min(MAX_WAIT_MS, waitMs)) : 0;
  const startedAt = Date.now();
  const flight = beginDraw();
  if (!selectionOverlay.drawing) {
    // start() завершился сразу — окна не открылись. Это сбой системы; «обводите область» звучать не должно.
    const o = await flight.applied;
    if (o.failed) return { started: false, failed: true, failReason: o.failReason ?? "no-windows" };
  }
  if (wait <= 0) {
    void flight.applied.catch((e) => log.warn("выделение не состоялось", e instanceof Error ? e.message : String(e)));
    return { started: true, waiting: true };
  }
  // Гоняем таймер против ЧИСТОГО исхода оверлея, а не против применения (захват + хеш — сотни мс):
  // обвёл за полсекунды до дедлайна → область уже в сторе и ушла серверу, ответ обязан её нести.
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), wait));
  const res = await Promise.race([flight.outcome, timeout]);
  if (res === "timeout" && !flight.settled()) {
    return { started: true, timedOut: true, overlayOpen: selectionOverlay.drawing, waitedMs: Date.now() - startedAt };
  }
  const o = await flight.applied; // исход есть — дождёмся применения (рамка/отпечаток), чтобы ответ не опережал стор
  return fromOutcome(o, Date.now() - startedAt);
}

/** Снять СВЕЖИЙ кадр выделенной области. Нет выделения → честная ошибка (её увидит и модель, и владелец). */
export async function selectionView(scale?: number): Promise<SelectionViewResult> {
  if (selectionOverlay.drawing) {
    // Контроль-3: это состояние системы (вуаль), а не сбой актуатора — DrawingOverlayError маппится в
    // overlay_drawing, и сервер не считает такой раунд провалом модели (иначе два view → эскалация тира).
    throw new DrawingOverlayError(
      "Сейчас идёт рисование: на экране вуаль режима выделения, область ещё не зафиксирована. " +
        'Дождись исхода (screen_selection{op:"start", waitMs}) или спроси владельца — смотреть пока нечего.',
    );
  }
  const sel = selectionStore.get();
  if (!sel) {
    throw new Error(
      "Владелец сейчас ничего не выделял на экране. Попроси обвести область (screen_selection{op:\"start\"} " +
        "или горячая клавиша) либо смотри экран обычным screen_capture.",
    );
  }
  const shot = await captureScreen(sel.monitorIndex, {
    rect: { x: sel.x, y: sel.y, w: sel.w, h: sel.h, space: "screen" },
    scale,
    updateMapping: false,
  });
  const out: SelectionViewResult = {
    image: shot.image,
    mediaType: shot.mediaType,
    width: shot.width,
    height: shot.height,
    selection: sel,
    ageMs: selectionStore.ageMs(Date.now()),
    ...(shot.crop ? { crop: shot.crop } : {}),
  };
  // Отпечаток сравниваем ТОЛЬКО с кадром того же масштаба, что эталон (лупа ресемплирует и переворачивает
  // биты у порога — «изменилось» на неизменном экране было бы враньём).
  const unscaled = scale === undefined || scale === 1;
  if (sel.hash && unscaled) {
    try {
      const probe = await perceptualHash(shot.image, shot.width, shot.height);
      out.changedSinceSelection = probe.hash !== sel.hash;
    } catch {
      /* не посчитали отпечаток — просто не утверждаем ничего о переменах */
    }
  }
  log.info("взгляд на выделенную область", { w: sel.w, h: sel.h, monitor: sel.monitorIndex, ageMs: out.ageMs });
  return out;
}

/**
 * Снять выделение. Три исхода, потому что владелец их различает: рамка снята / закрыт режим рисования
 * (вуаль погашена, области ещё не было) / снимать было нечего. Последнее НЕ выдаём за действие.
 */
export function selectionClear(opts?: { byOwner?: boolean }): { cleared: boolean; drawCancelled: boolean } {
  const had = selectionStore.active;
  const wasDrawing = selectionOverlay.drawing;
  selectionStore.clear();
  // Контроль-3: КТО закрыл вуаль — часть исхода. Повторный хоткей и голосовая команда — рука владельца
  // (reason «esc» → серверу «Владелец закрыл»); смена мониторов и модельный clear — «cleared» (не он).
  selectionOverlay.hideAll(opts?.byOwner ? "esc" : "cleared");
  return { cleared: had, drawCancelled: wasDrawing };
}
