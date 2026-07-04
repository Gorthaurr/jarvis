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
  ensure();
  log.debug("input.type", { len: text.length });
  // Таймаут по длине: посимвольный ввод с джиттером — десятки секунд на абзац. Дефолтные 5с
  // рвали длинный текст на полуслове (RPC reject), а сайдкар продолжал печатать → рассинхрон.
  const timeoutMs = Math.min(180_000, 5_000 + text.length * 120);
  await sidecar().request("type", { text }, timeoutMs);
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
  // §6 «не навреди»: опасные комбо (Alt+F4 и т.п.) НЕ шлём — они закрывают/блокируют окно или
  // систему, в т.ч. могут закрыть сам Джарвис (см. инцидент). Закрывать приложения — app.close.
  if (isBlockedCombo(combo)) {
    log.warn("input.key: опасное комбо заблокировано", { combo });
    throw new BlockedKeyError(combo);
  }
  const keys = comboKeys(combo);
  // H4: down/up держат модификаторы зажатыми МЕЖДУ вызовами. Перед down сверяем ИТОГОВУЮ
  // комбинацию (уже удерживаемое ∪ новые клавиши) — иначе Alt(down)+F4(down) обходит блок-лист.
  if (mode === "down") {
    const effective = [...heldKeys, ...keys].join("+");
    if (isBlockedCombo(effective)) {
      log.warn("input.key: опасное комбо собрано удержанием — заблокировано", { effective, held: [...heldKeys] });
      heldKeys.clear(); // не оставляем зажатые модификаторы висеть в учёте
      throw new BlockedKeyError(effective);
    }
  }
  ensure();
  try {
    await sidecar().request("key", { combo, mode, scancode });
  } catch (e) {
    // Ошибка исполнения — считаем клавиши отпущенными (реального удержания нет), чтобы не залипало.
    if (mode === "down") for (const k of keys) heldKeys.delete(k);
    throw e;
  }
  // Учёт удержания ведём только по успеху RPC. press = атомарное нажать+отпустить (не удерживается).
  if (mode === "down") for (const k of keys) heldKeys.add(k);
  else if (mode === "up") for (const k of keys) heldKeys.delete(k);
  else heldKeys.clear(); // полный press: сбрасываем накопленное удержание (клавиатура «отпущена»)
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
): Promise<{ screenX: number; screenY: number } | undefined> {
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
  if (method !== "physical") {
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
  if (target.by === "coords") {
    await sidecar().request("click", { x: coords!.x, y: coords!.y, restoreCursor });
  } else if (target.by === "handle") {
    await sidecar().request("click", { handle: target.handle, restoreCursor });
  } else {
    const g = await ground({ role: target.role, name: target.name }); // role → handle → физ.клик по центру
    await sidecar().request("click", { handle: g.handle, restoreCursor });
  }
  return resolved;
}

/** Единый маркер «не реализовано/недоступно» — dispatch маппит его в error.runtime. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: синтетический ввод недоступен (win-сайдкар apps/sidecar-win)`);
    this.name = "NotImplementedError";
  }
}
