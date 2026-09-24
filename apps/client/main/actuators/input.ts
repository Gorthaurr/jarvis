/**
 * Актуатор синтетического ввода (мышь/клавиатура) через win-сайдкар (§6).
 *
 * Синтетический ввод (SendInput) — это FALLBACK (§6): основной путь — UIA-паттерны
 * (ground.ts / ui.invoke). input.* используются там, где UIA недоступна (canvas, игры).
 *
 * Реальный SendInput — в нативном сайдкаре apps/sidecar-win (C#/.NET); main общается
 * с ним по stdio JSON-RPC (sidecar-client.ts). Синтетика маркируется (extra-info) —
 * чтобы арбитраж ввода (§6) отличал её от физической активности пользователя.
 * Если сайдкар не поднят — бросаем NotImplementedError (dispatch → runtime-ошибка).
 */
import { noteJarvisInput } from "./input-mark.js";
import { keyGatedUnderVeil, mouseGatedUnderVeil } from "../selection/veil-policy.js";
// §режим выделения: пока на экране вуаль оверлея, ФИЗИЧЕСКИЙ ввод (SendInput) попал бы в неё, а не в цель,
// и вернулся бы ok — ложный успех. Гейт стоит ИМЕННО здесь, в точке инжекции: сюда сходятся dispatch,
// реплей навыка (input_batch/skill_execute/авто-макрос) и SDK-мост. Бесшумную ступень (UIA invoke) не
// гейтим — она мышь не трогает. Класс и гарды — в selection/overlay-error.ts (контроль-6: тот же гард нужен
// apps.focusApp/windows.focusWindow, которые реплей зовёт мимо dispatch); реэкспорт держит прежние импорты.
import { DrawingOverlayError, assertNoDrawingOverlay, assertNoOverlayDuring } from "../selection/overlay-error.js";
export { DrawingOverlayError };
import type { Target } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { sidecar } from "./sidecar-client.js";
import { getLastCaptureMapping } from "./screen.js";
import { ground, groundAtPoint, invoke } from "./ground.js";

const log = createLogger("actuator:input");

function ensure(): void {
  if (!sidecar().ready) throw new NotImplementedError("сайдкар не запущен");
}

/**
 * Опасные глобальные комбо, которые НЕЛЬЗЯ слать вслепую эмуляцией ввода (§6 «не навреди»).
 * Инцидент: «закрой Доту» → агент сфокусировал окно и послал Alt+F4 → закрыл САМ Джарвис.
 * Alt+F4 закрывает активное окно (часто — не то), Win+L/R/D/M и Ctrl+Alt+Del трогают систему/
 * безопасность. Закрытие приложений — отдельным БЕЗОПАСНЫМ путём (app.close по процессу,
 * исключая Джарвис), а не клавишами. Блокировка нормализует регистр/порядок/алиасы.
 */
const BLOCKED_COMBOS: ReadonlySet<string> = new Set(
  ["Alt+F4", "Win+L", "Win+R", "Win+D", "Win+M", "Win+Tab", "Ctrl+Alt+Delete", "Ctrl+Alt+Del", "Alt+Space"].map(
    normalizeCombo,
  ),
);

/** Нормализовать комбо: нижний регистр, без пробелов, алиасы (meta/super/lwin→win, del→delete), сорт. */
export function normalizeCombo(combo: string): string {
  return combo
    .toLowerCase()
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) =>
      k === "meta" || k === "super" || k === "lwin" || k === "rwin" || k === "windows" || k === "cmd"
        ? "win"
        : k === "del"
          ? "delete"
          : k === "control"
            ? "ctrl"
            : k,
    )
    // Дедуп клавиш ПЕРЕД сортировкой: иначе «Alt+Alt+F4» → «alt+alt+f4» ≠ «alt+f4» обходил блок-лист
    // (ОС трактует дубль модификатора так же). new Set схлопывает повтор.
    .reduce<string[]>((acc, k) => (acc.includes(k) ? acc : [...acc, k]), [])
    .sort()
    .join("+");
}

/** Запрещённое ли это комбо (закрывает/блокирует окно/систему, в т.ч. может закрыть Джарвис). */
export function isBlockedCombo(combo: string): boolean {
  return BLOCKED_COMBOS.has(normalizeCombo(combo));
}

/**
 * §6 «не навреди», H4: множество ФИЗИЧЕСКИ УДЕРЖИВАЕМЫХ клавиш между вызовами. Режимы down/up
 * держат модификатор зажатым МЕЖДУ RPC-вызовами → опасное комбо (Alt+F4) можно собрать по частям:
 * `Alt` (down) + `F4` (down) — каждый вызов по отдельности не в блок-листе, но итог = Alt+F4.
 * Поэтому перед КАЖДЫМ down сверяем итоговую комбинацию (held ∪ новые клавиши), а не только клавиши
 * одного вызова. Сбрасываем на up/полном press/ошибке, чтобы состояние не залипало.
 */
const heldKeys: Set<string> = new Set();
/** Контроль-9: кнопки мыши, зажатые НАМИ (`op:"down"` без `up`) — их отпускает `releaseHeldPointer` при закрытии вуали. */
const heldButtons: Set<string> = new Set();
/** Контроль-10: кнопки, отпущенные НЕ агентом, а системой при закрытии вуали — сообщаем об этом один раз. */
const autoReleased: Map<string, number> = new Map();

/** Разложить combo в набор нормализованных клавиш (переиспользуем логику normalizeCombo). */
function comboKeys(combo: string): string[] {
  const norm = normalizeCombo(combo);
  return norm ? norm.split("+") : [];
}

/** Тест-хелпер: сбросить учёт удерживаемых клавиш (изоляция между кейсами). */
export function resetHeldKeys(): void {
  heldKeys.clear();
}

/** Тест-хелпер: засеять «удерживаемые» клавиши (эмуляция успешного down без сайдкара). */
export function seedHeldKeys(combo: string): void {
  for (const k of comboKeys(combo)) heldKeys.add(k);
}

/** Печать текста посимвольно с человеческим джиттером в сайдкаре (§3 принцип 3). */
export async function typeText(text: string): Promise<void> {
  assertNoDrawingOverlay();
  noteJarvisInput();
  ensure();
  log.debug("input.type", { len: text.length });
  // Таймаут по длине: посимвольный ввод с джиттером — десятки секунд на абзац. Дефолтные 5с
  // рвали длинный текст на полуслове (RPC reject), а сайдкар продолжал печатать → рассинхрон.
  const timeoutMs = Math.min(180_000, 5_000 + text.length * 120);
  const t0 = Date.now();
  await sidecar().request("type", { text }, timeoutMs);
  // Контроль-6 (C5R-2): печать идёт секунды — вуаль, открывшаяся ПОСРЕДИ, забирает остаток нажатий в окно
  // рисования, а сайдкар отвечает ok. Честно: ушло, исход не подтверждён (не «выполнено» и не «не выполнено»).
  assertNoOverlayDuring(t0, "Печать текста");
}

/**
 * combo в нотации протокола: "Ctrl+S", "ArrowRight", "Space", "W".
 * mode: press (нажать+отпустить) | down (удержать — движение в играх) | up (отпустить).
 * scancode: true → слать сканкодами (игры на DirectInput/RawInput).
 */
export async function pressKey(
  combo: string,
  mode?: "press" | "down" | "up",
  scancode?: boolean,
): Promise<void> {
  // Отметка «ввод наш» стоит ДО любых гардов (консервативно: заблокированный вызов лучше счесть своим, чем
  // приписать владельцу — input-mark.test).
  noteJarvisInput();
  // §6 «не навреди»: опасные комбо (Alt+F4 и т.п.) НЕ шлём — они закрывают/блокируют окно или
  // систему, в т.ч. могут закрыть сам Джарвис (см. инцидент). Закрывать приложения — app.close.
  if (isBlockedCombo(combo)) {
    log.warn("input.key: опасное комбо заблокировано", { combo });
    throw new BlockedKeyError(combo);
  }
  const keys = comboKeys(combo);
  // H4 + аудит ядра [10]: удерживаемые модификаторы (down без up) живут МЕЖДУ вызовами и могут собрать
  // опасное комбо с ЛЮБЫМ ШЛЮЩИМ НАЖАТИЕ вызовом — не только down. Прежний гард работал только для
  // mode==="down", поэтому Alt(down) + F4(press) синтезировал Alt+F4 мимо блок-листа. Сверяем ИТОГОВУЮ
  // комбинацию (удерживаемое ∪ новые) для down И press (mode !== "up"; up лишь ОТПУСКАЕТ, нажатия не шлёт).
  if (mode !== "up" && heldKeys.size > 0) {
    const effective = [...heldKeys, ...keys].join("+");
    if (isBlockedCombo(effective)) {
      log.warn("input.key: опасное комбо собрано удержанием — заблокировано", { effective, held: [...heldKeys] });
      // НЕ чистим heldKeys: удерживаемые клавиши физически всё ещё зажаты сайдкаром — «забыть» их =
      // десинк, и следующий заход собрал бы то же комбо уже мимо гарда (аудит ядра [10]).
      throw new BlockedKeyError(effective);
    }
  }
  // Контроль-4: ПОЛИТИКА (запрет комбо) стоит выше СОСТОЯНИЯ (вуаль): Alt+F4 под вуалью получал транзиентное
  // «дождись и повтори» вместо постоянного запрета. mode:"up" лишь ОТПУСКАЕТ удерживаемое — в оверлей побочного
  // эффекта не даёт, а залипшая до закрытия вуали клавиша вредит.
  if (keyGatedUnderVeil(mode)) assertNoDrawingOverlay();
  ensure();
  // Контроль-9 (presskey-no-veil-postcheck): у печати (контроль-6), клика и мыши (контроль-6/8) пост-проверка есть,
  // у нажатия клавиши не было вовсе. Сайдкар держит клавишу и спит между модификаторами (десятки мс, у scancode/
  // `mode:"down"` дольше) — вуаль, открывшаяся внутри RPC, принимает Enter коммита отправки на себя, а RPC
  // возвращает успех: журнал пишет «ok» про отправку, которой не было.
  const tKey = Date.now();
  // Контроль-10 (presskey-catch-clears-held): при ошибке RPC откатываем ТОЛЬКО СВОЙ вклад. Прежний код стирал и
  // клавиши, удержанные ПРЕДЫДУЩИМИ успешными вызовами: провалившийся повторный `down` Alt «забывал» реально
  // зажатый Alt, и следующий `press F4` собирал Alt+F4 мимо блок-листа (инцидент «закрыл сам себя»).
  const newlyHeld = mode === "down" ? keys.filter((k) => !heldKeys.has(k)) : [];
  try {
    await sidecar().request("key", { combo, mode, scancode });
  } catch (e) {
    for (const k of newlyHeld) heldKeys.delete(k);
    throw e;
  }
  // Учёт удержания ведём только по успеху RPC. press атомарен (нажать+отпустить СВОИ клавиши) и НЕ
  // отпускает раздельно удерживаемые модификаторы — их снимает только явный up. Прежний heldKeys.clear()
  // на press ДЕСИНКал учёт: Alt оставался физически зажат, но забывался → следующий press/down собирал
  // Alt+combo мимо гарда (аудит ядра [10]).
  if (mode === "down") for (const k of keys) heldKeys.add(k);
  else if (mode === "up") for (const k of keys) heldKeys.delete(k);
  if (keyGatedUnderVeil(mode)) assertNoOverlayDuring(tKey, "Нажатие клавиши");
}

/** Заблокированное опасное комбо (§6). dispatch маппит в runtime-ошибку — агент выберет иной путь. */
export class BlockedKeyError extends Error {
  constructor(combo: string) {
    super(
      `комбинация «${combo}» запрещена (закрывает/блокирует окно или систему — может задеть Джарвис). ` +
        "Чтобы ЗАКРЫТЬ приложение, используй инструмент app_close (по процессу), а НЕ Alt+F4.",
    );
    this.name = "BlockedKeyError";
  }
}

/**
 * Клик по цели. §бесшумный-ввод: по умолчанию БЕЗ движения физического курсора юзера — лестница деградации:
 *   1) UIA-invoke по handle/роли (без курсора);
 *   2) по координатам — `ground.at` под точкой → invoke (без курсора);
 *   3) физ.клик SendInput С ВОЗВРАТОМ курсора (restoreCursor) — фолбэк, когда UIA слепа (canvas/игра).
 * method="physical" → сразу ступень 3 (игры/canvas, где silent заведомо не сработает — не тратим round-trip).
 * restoreCursor — вернуть курсор после физ.клика (ставит index.ts: true при простое юзера, false если он сам двигает мышь).
 * Возвращает РАЗРЕШЁННЫЕ экранные координаты клика (DIP virtual-desktop) для coords-целей — из них
 * сервер компилирует реплей-макрос навыка (§8); для handle/role-целей — undefined.
 */
export async function click(
  target: Target,
  method: "silent" | "physical" = "silent",
  restoreCursor = true,
  opts?: { button?: "left" | "right" | "middle"; count?: number },
): Promise<{ screenX: number; screenY: number } | undefined> {
  const button = opts?.button ?? "left";
  const count = Math.max(1, Math.min(3, opts?.count ?? 1));
  // §режим выделения (контроль-3): явно ФИЗИЧЕСКИЙ клик (coords / physical / правая-средняя-дабл) гейтим
  // ДО ensure() — иначе без сайдкара гейт недостижим, а именно этим путём кликают реплей навыка и SDK-мост.
  // Бесшумную ступень (UIA invoke по handle/role) не трогаем: её же советует текст отказа.
  if (method === "physical" || target.by === "coords" || !(button === "left" && count === 1)) assertNoDrawingOverlay();
  ensure();
  // coords приходят в координатах ПОСЛЕДНЕГО screen_capture (thumbnail монитора) → логические virtual-desktop.
  // space="screen" (§8 реплей-макрос) — уже АБСОЛЮТНЫЕ экранные DIP: маппинг снимка не применяем.
  const coords =
    target.by === "coords"
      ? target.space === "screen"
        ? { x: target.x, y: target.y }
        : (() => {
            const m = getLastCaptureMapping();
            return { x: m ? m.boundsX + target.x / m.scale : target.x, y: m ? m.boundsY + target.y / m.scale : target.y };
          })()
      : null;
  const resolved = coords ? { screenX: coords.x, screenY: coords.y } : undefined;

  // БЕСШУМНАЯ лестница (ступени 1-2). Провал ступени → честный фолбэк на физ.клик ниже (не молча).
  // §Волна2 (2.4): правый/средний/дабл-клик UIA-invoke не выразить — сразу физический путь.
  const silentPossible = button === "left" && count === 1;
  if (method !== "physical" && silentPossible) {
    try {
      if (target.by === "handle" || target.by === "role") {
        await invoke(target, "invoke"); // UIA invoke — курсор не двигается, окно не в фокусе
        return resolved;
      }
      if (coords) {
        const g = await groundAtPoint(coords.x, coords.y); // элемент под точкой
        await invoke({ by: "handle", handle: g.handle }, "invoke");
        return resolved;
      }
    } catch (e) {
      log.debug("бесшумный клик не удался — фолбэк на физ.клик (курсор вернём при простое)", e instanceof Error ? e.message : String(e));
      // проваливаемся ниже в физ.клик
    }
  }

  // ФИЗ.КЛИК (method=physical ИЛИ фолбэк бесшумного): SendInput; курсор возвращаем при простое юзера (§бесшумный-ввод).
  // Метим «это наш ввод» ИМЕННО ЗДЕСЬ: бесшумная ступень (UIA invoke) системный простой не сбрасывает,
  // и метить её значило бы приписывать себе ввод, которого не было (ревью 2026-09-02).
  assertNoDrawingOverlay();
  noteJarvisInput();
  // Контроль-8 (click-role-no-postcheck): между гардом и инжекцией здесь не микросекунды — грундинг по РОЛИ идёт к
  // сайдкару и на слепом/тяжёлом окне длится секунды. Вуаль, открывшаяся в этом окне, принимала SendInput на себя, а
  // сайдкар отвечал ok → раунд засчитывался УСПЕШНОЙ мутацией. Для typeText/mouse этот класс закрыт контролем-6.
  const t0 = Date.now();
  if (target.by === "coords") {
    await sidecar().request("click", { x: coords!.x, y: coords!.y, restoreCursor, button, count });
  } else if (target.by === "handle") {
    await sidecar().request("click", { handle: target.handle, restoreCursor, button, count });
  } else {
    const g = await ground({ role: target.role, name: target.name }); // role → handle → физ.клик по центру
    await sidecar().request("click", { handle: g.handle, restoreCursor, button, count });
  }
  assertNoOverlayDuring(t0, "Клик");
  return resolved;
}

/** Параметры полной мыши (§Волна2 2.4) — зеркало ActionCommand input.mouse без kind. */
export interface MouseParams {
  op: "move" | "down" | "up" | "wheel" | "drag";
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  button?: "left" | "right" | "middle";
  dy?: number;
  dx?: number;
  space?: "screen";
}

/**
 * §Волна2 (2.4): полная мышь — hover/удержание/колесо/перетаскивание (контекстные меню, DnD,
 * игровые механики). Координаты — как у click: vision-координаты последнего screen_capture
 * (space:"screen" — абсолютные DIP virtual-desktop без маппинга).
 */
export async function mouse(params: MouseParams): Promise<void> {
  noteJarvisInput(); // отметка «это наш ввод» — ПЕРЕД гардами (контроль-4: заблокированный ввод всё равно считается нашим)
  // Контроль-9 (mouse-up-terminates-owner-drawing): мышь под вуалью гейтится ЦЕЛИКОМ — `mouseup` в окно рисования
  // ЗАВЕРШАЕТ выделение владельца в точке курсора (см. veil-policy). Залипшую кнопку снимает `releaseHeldPointer`
  // при закрытии вуали.
  if (mouseGatedUnderVeil(params.op)) assertNoDrawingOverlay();
  ensure();
  const m = params.space === "screen" ? null : getLastCaptureMapping();
  const map = (x?: number, y?: number): { x?: number; y?: number } => {
    if (x === undefined || y === undefined) return { x, y };
    if (!m) return { x, y };
    return { x: m.boundsX + x / m.scale, y: m.boundsY + y / m.scale };
  };
  const from = map(params.x, params.y);
  const to = map(params.toX, params.toY);
  log.debug("input.mouse", { op: params.op, button: params.button });
  const t0 = Date.now();
  // Контроль-9: реестр зажатых кнопок — чтобы отпустить их при закрытии вуали, а не ждать watchdog сайдкара.
  const btn = params.button ?? "left";
  // Контроль-10: агент думает, что всё ещё держит кнопку, а её отпустила система — честная ошибка ОДИН раз,
  // вместо тихого «ok» на `up`, который ничего не отпускает.
  if (params.op === "up" && autoReleased.has(btn)) {
    autoReleased.delete(btn);
    throw new PointerAutoReleasedError(btn);
  }
  if (params.op === "down") {
    heldButtons.add(btn);
    autoReleased.delete(btn);
  } else if (params.op === "up") heldButtons.delete(btn);
  await sidecar().request(
    "mouse",
    {
      op: params.op,
      x: from.x,
      y: from.y,
      toX: to.x,
      toY: to.y,
      button: params.button,
      dy: params.dy,
      dx: params.dx,
    },
    15_000, // drag с интерполяцией — сотни мс; запас на медленный UI
  );
  // Контроль-6 (C5R-2): drag/удержание с интерполяцией — долгие; вуаль посреди = ушло, исход не подтверждён.
  // Контроль-8: у отпускания кнопки побочного эффекта в оверлей нет — его и пост-проверка не касается.
  if (mouseGatedUnderVeil(params.op)) assertNoOverlayDuring(t0, "Действие мыши");
}

/**
 * Контроль-9 (mouse-up-terminates-owner-drawing): отпустить кнопки, зажатые НАМИ, минуя гейт вуали.
 * Зовётся ровно в момент ЗАКРЫТИЯ вуали (actuators/selection.ts): пока вуаль на экране, `up` уходить не должен —
 * он завершил бы выделение владельца; после закрытия держать кнопку зажатой тоже нельзя.
 */
export async function releaseHeldPointer(): Promise<void> {
  if (heldButtons.size === 0) return;
  const buttons = [...heldButtons];
  heldButtons.clear();
  for (const button of buttons) {
    try {
      noteJarvisInput();
      await sidecar().request("mouse", { op: "up", button }, 5_000);
      // Контроль-10 (release-held-pointer-silent): факт авто-отпускания ЗАПОМИНАЕТСЯ. Кнопка отпускается там, где
      // сейчас курсор (владелец только что рисовал рамку), то есть перетаскивание завершилось НЕ там, где агент
      // планировал. Молча вернуть это в «повтори жест» = ложное «ничего не случилось».
      autoReleased.set(button, Date.now());
      log.info("отпустил зажатую кнопку мыши после закрытия вуали", { button });
    } catch (e) {
      log.warn("не смог отпустить зажатую кнопку мыши", { button, err: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Кнопка была отпущена СИСТЕМОЙ (закрытие вуали), а не агентом — исход перетаскивания не подтверждён. */
export class PointerAutoReleasedError extends Error {
  constructor(button: string) {
    super(
      `кнопка «${button}» была отпущена системой при закрытии режима выделения — удерживать её под вуалью нельзя. ` +
        "Перетаскивание завершилось в точке, где владелец закончил обводить область: ИСХОД НЕ ПОДТВЕРЖДЁН. " +
        "Сверь состояние (ui_snapshot/screen_capture) и не повторяй жест вслепую.",
    );
    this.name = "PointerAutoReleasedError";
  }
}

/** Единый маркер «не реализовано/недоступно» — dispatch маппит его в error.runtime. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: синтетический ввод недоступен (win-сайдкар apps/sidecar-win)`);
    this.name = "NotImplementedError";
  }
}
