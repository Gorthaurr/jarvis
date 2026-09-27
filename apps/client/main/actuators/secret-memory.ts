/**
 * W2 П2 (§0): ПАМЯТЬ РУБЕЖА СЕКРЕТОВ МЕЖДУ ИНЖЕКЦИЯМИ — состояние и ленивые сбросы (наполняет injection-journal.ts).
 *
 *  - набранное в поле (`inputBuffer`: цифры для Луны по склейке «4276 1600» + « 1234 5675», текст — для pendingText П1);
 *  - куда кликнули последним: секретная ли цель (зеркало handle: `•••`, подсказки) — дополнение к `focused()`, когда
 *    read.screen у Electron/Qt не отвечает; сбрасывается клавишей, уводящей из поля, и вводом владельца;
 *  - какие клавиши зажаты (`mode:"down"`): автоввод менеджера паролей и вставка собираются и удержанием;
 *  - какое окно выводили вперёд (сброс эпохи только при СМЕНЕ окна: act с тем же `app` поле не меняет).
 */
import { normalizeCombo } from "@jarvis/shared";
import { type MirrorEntry, mirrorOf } from "./handle-mirror.js";
import { inputBuffer } from "./input-buffer.js";
import { lastOwnerInput } from "./input-mark.js";
import { sidecar } from "./sidecar-client.js";

/** Пауза, после которой набранное считается другим вводом (план П2, шаг 4: > 10 с). */
export const BUFFER_IDLE_MS = 10_000;

export interface ClickMemory {
  /** Цель клика — поле пароля/кода. */
  secret: boolean;
  label: string;
  /** Процесс цели (из снапшота); неизвестен — память действует в любом окне до сброса. */
  pid?: number;
  at: number;
}

const st = {
  click: null as ClickMemory | null,
  held: new Set<string>(),
  focusHwnd: undefined as number | undefined,
  lastEventAt: 0,
};

/** Поколение сайдкара (моки без него — 0), как у ground.ts. */
export const sidecarGen = (): number => (sidecar() as { generation?: number }).generation ?? 0;

/** Запись зеркала по handle в текущем поколении. */
export const mirrorEntry = (handle: unknown): MirrorEntry | null => mirrorOf(handle, sidecarGen());

/** Новая эпоха фокуса: набранное забыто, память клика — `click` (null — цель неизвестна). */
export function newEpoch(click: ClickMemory | null = null): void {
  inputBuffer.reset();
  st.click = click;
}

/** Наше событие ввода (инжекция, смена окна) — рубеж для сравнения с живым вводом владельца. */
export function markEvent(now: number): void {
  st.lastEventAt = now;
}

/**
 * Ленивые сбросы (без подписок и таймеров): владелец сам вводил после нашего последнего события (сайдкар отличает
 * его ввод от нашей синтетики по dwExtraInfo — input-mark.ts) → поле и память клика уже не наши; пауза > 10 с →
 * набранное забыто.
 */
export function syncSecretState(now = Date.now()): void {
  const owner = lastOwnerInput();
  if (owner > st.lastEventAt) {
    if (st.lastEventAt > 0) newEpoch();
    st.lastEventAt = owner;
  }
  if (!inputBuffer.empty && now - inputBuffer.lastAppendAt > BUFFER_IDLE_MS) inputBuffer.reset();
}

export function clickMemory(): ClickMemory | null {
  return st.click;
}

export function forgetClick(): void {
  st.click = null;
}

export const comboKeys = (combo: string): string[] => normalizeCombo(combo).split("+").filter(Boolean);

/** Итоговое комбо нажатия: удерживаемые клавиши ∪ новое (Ctrl↓, Alt↓, затем «A» = Ctrl+Alt+A). */
export function effectiveCombo(combo: string): string {
  return normalizeCombo([...st.held, ...comboKeys(combo)].join("+"));
}

/** Учёт удержания (`mode:"down"` / `"up"`) — как у pressKey, но свой: рубеж судит итоговое комбо. */
export function holdKeys(combo: string, down: boolean): void {
  for (const k of comboKeys(combo)) {
    if (down) st.held.add(k);
    else st.held.delete(k);
  }
}

/**
 * Окно выведено вперёд (window.focus / app.focus / act с `app`): эпоха меняется только при СМЕНЕ окна — повторный
 * фокус того же окна (каждый act с тем же app) поле не меняет, и карта по кускам в нём должна склеиваться.
 * hwnd неизвестен (app.launch — новое окно) → сброс всегда.
 */
export function noteFocusChange(hwnd?: number): void {
  if (hwnd !== undefined && hwnd === st.focusHwnd) return;
  st.focusHwnd = hwnd;
  markEvent(Date.now());
  newEpoch();
}

/** Тесты: забыть всё (буфер, память клика, удержание, окно). */
export function resetSecretMemory(): void {
  newEpoch();
  st.held.clear();
  st.focusHwnd = undefined;
  st.lastEventAt = 0;
}
