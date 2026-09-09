/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ (2026-09-03) — состояние указателя владельца на сервере и его строка в промпте.
 *
 * Зачем в контексте КАЖДОГО хода: владелец обводит кусок экрана и говорит «вот смотри, тут недочёт».
 * Без этой строки модель не знает, что «тут» вообще на что-то показывает, и либо переспрашивает, либо
 * гадает по всему экрану. Со строкой — знает, что указатель есть, где он и НАСКОЛЬКО ОН СВЕЖ.
 *
 * ЧЕСТНОСТЬ: строка НЕ содержит того, что в области нарисовано — только факт указания и его возраст.
 * Содержимое добывается инструментом (свежий кадр), иначе Джарвис рассуждал бы о картинке, которой не
 * видел. Возраст считается по часам СЕРВЕРА: клиент присылает свой `ageMs` (разница на ОДНИХ часах),
 * и мы храним `receivedAt = now − ageMs` — так возраст переживает рестарт/реконнект, а часы ПК ни при чём.
 *
 * Это НАШ статус (координаты от нашего же клиента), поэтому идёт доверенным текстом — как паспорт
 * возможностей, без untrusted-обёртки. Ровно поэтому payload САНИРУЕТСЯ (`sanitizeSelection`):
 * граница «данные/инструкции» проводится на сервере, а метка монитора — единственная строка извне.
 *
 * АДВЕРС-РЕВЬЮ 2026-09-05: состояние живёт в `SelectionSlot`, который хранится в `session.scoped`
 * (переживает пересоздание agentDeps на реконнекте) и сравнивается по КЛЮЧУ идентичности, а не по
 * отрендеренной строке — иначе тикающий возраст читался бы как «выделение изменилось» каждый раунд.
 */
import type { ScreenSelection } from "@jarvis/protocol";

export interface SelectionState {
  selection: ScreenSelection;
  /** Момент выделения по часам сервера (now − ageMs клиента). */
  receivedAt: number;
}

const MONITOR_LABEL_RE = /^Монитор \d{1,3} — \d{2,5}×\d{2,5}(?: \([^()]{1,40}\))?$/u;
const MAX_SIDE = 20_000;
/** Сколько живёт присланный клиентом признак «идёт рисование» без подтверждения (окно рисования само гаснет за 120 с). */
const DRAWING_STALE_MS = 180_000;

/**
 * Принять только то, что похоже на выделение от нашего клиента: конечные целые координаты, разумные
 * стороны, индекс монитора в пределах, метка монитора нашего же формата (иначе — «Монитор N»).
 * Мусор → null (в промпт не попадёт ничего, лучше, чем «NaN×-5 на «…»»).
 */
export function sanitizeSelection(raw: unknown): ScreenSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const x = num(r.x);
  const y = num(r.y);
  const w = num(r.w);
  const h = num(r.h);
  const monitorIndex = num(r.monitorIndex);
  if (x === null || y === null || w === null || h === null || monitorIndex === null) return null;
  if (w < 8 || h < 8 || w > MAX_SIDE || h > MAX_SIDE || Math.abs(x) > 10 * MAX_SIDE || Math.abs(y) > 10 * MAX_SIDE) return null;
  if (monitorIndex < 0 || monitorIndex > 32) return null;
  const out: ScreenSelection = { x, y, w, h, monitorIndex };
  out.monitor = typeof r.monitor === "string" && MONITOR_LABEL_RE.test(r.monitor) ? r.monitor : `Монитор ${monitorIndex + 1}`;
  if (typeof r.createdAt === "number" && Number.isFinite(r.createdAt)) out.createdAt = r.createdAt;
  if (typeof r.hash === "string" && /^[0-9a-f]{1,32}$/u.test(r.hash)) out.hash = r.hash;
  return out;
}

/** Ключ идентичности выделения: меняется ТОЛЬКО когда сменилась область, не когда тикает возраст. */
export function selectionKey(state: SelectionState | null | undefined): string {
  if (!state) return "";
  const s = state.selection;
  return `${s.x},${s.y},${s.w},${s.h},${s.monitorIndex},${s.createdAt ?? state.receivedAt}`;
}

/**
 * Держатель состояния на СЕССИЮ (кладётся в session.scoped): и хендлер client.selection, и идущая
 * петля читают одно и то же — после реконнекта agentDeps пересоздаётся, а слот остаётся.
 */
export class SelectionSlot {
  private state: SelectionState | null = null;
  /**
   * Контроль-9: идёт ли СЕЙЧАС фаза рисования (клиент присылает её в `client.selection`). Нужна серверным путям,
   * которые не проходят через клиентский гейт `ActionCommand` — прежде всего `browser_open` через расширение.
   */
  private draw = false;
  private drawAt = 0;

  /**
   * Признак ПРОТУХАЕТ: «открылась» приходит событием, а «закрылась» может не прийти НИКОГДА (клиент упал,
   * канал оборвался посреди рисования). Липкое «вуаль открыта» отказывало бы `browser_open` до конца сессии —
   * ровно тот класс, который этот же контроль чинил в петле. Само окно рисования живёт максимум
   * JARVIS_SELECTION_DRAW_TIMEOUT_MS (деф 120 с), запас берём кратный.
   */
  get drawing(): boolean {
    return this.draw && Date.now() - this.drawAt <= DRAWING_STALE_MS;
  }

  setDrawing(on: boolean, now = Date.now()): void {
    this.draw = on;
    this.drawAt = now;
  }

  get(): SelectionState | null {
    return this.state;
  }

  /**
   * Принять выделение от клиента. Та же область, что уже известна (тот же ключ) → receivedAt НЕ
   * переставляем: повторная присылка на реконнекте не должна «омолаживать» указание.
   */
  set(selection: ScreenSelection | null, ageMs: number | undefined, now: number): SelectionState | null {
    if (!selection) {
      this.state = null;
      return null;
    }
    const age = typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : 0;
    const next: SelectionState = { selection, receivedAt: now - age };
    if (this.state && selectionKey(this.state) === selectionKey(next)) return this.state;
    this.state = next;
    return next;
  }

  key(): string {
    return selectionKey(this.state);
  }
}

/** «40 с» / «6 мин» / «2 ч» — возраст указания словами. */
export function ageWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч`;
}

/**
 * Строка для промпта. Нет выделения → пустая строка (слот не рендерится: «выделения нет» каждый ход —
 * шум, а модель и так узнает об этом честной ошибкой инструмента).
 */
export function formatSelectionContext(state: SelectionState | null | undefined, now: number): string {
  if (!state) return "";
  const s = state.selection;
  const where = s.monitor ?? `Монитор ${s.monitorIndex + 1}`;
  const age = ageWords(now - state.receivedAt);
  return [
    `Владелец ПОКАЗЫВАЕТ на область экрана: ${s.w}×${s.h} на «${where}» (обведена ${age} назад; экранные координаты x=${s.x}, y=${s.y}).`,
    `Его «вот тут», «здесь», «это» в репликах относятся к ней. Чтобы УВИДЕТЬ, что там сейчас — screen_selection{op:"view"} (свежий кадр области).`,
    `Сама эта строка содержимого области НЕ описывает: не рассуждай о том, чего не смотрел.`,
  ].join(" ");
}
