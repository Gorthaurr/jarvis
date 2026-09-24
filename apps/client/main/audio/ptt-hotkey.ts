/**
 * Глобальная клавиша push-to-talk (ревью 2026-09-24, B-F8): запасной путь, когда локальный KWS не узнал
 * «Джарвис» (акцент, шум, далеко от микрофона). Раньше промах было нечем обойти — только повторять слово.
 *
 * Клавиша — константа, а не env: правило «один флаг — одно решение» (у выделения есть
 * JARVIS_SELECTION_HOTKEY; для PTT отдельный флаг не заводим, пока владелец не попросит другую).
 * Занята другой программой → честный WARN: молча «зарегистрированная» и не работающая клавиша — обещание,
 * которого нет (кнопка микрофона в окне при этом работает).
 */
export const PTT_HOTKEY = "Control+Alt+J";

export interface PttHotkeyDeps {
  /** globalShortcut.register — true, если клавиша зарегистрирована. Может бросить. */
  register(accel: string, cb: () => void): boolean;
  onPress(): void;
  log: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
  accel?: string;
}

/** Зарегистрировать клавишу PTT. Возвращает акселератор или null, если не вышло. */
export function registerPttHotkey(d: PttHotkeyDeps): string | null {
  const accel = d.accel ?? PTT_HOTKEY;
  try {
    if (!d.register(accel, d.onPress)) {
      d.log.warn(`push-to-talk: клавиша ${accel} занята другой программой — остаётся кнопка микрофона в окне`);
      return null;
    }
  } catch (e) {
    d.log.warn("push-to-talk: клавишу зарегистрировать не удалось", e instanceof Error ? e.message : String(e));
    return null;
  }
  d.log.info(`push-to-talk: ${accel} — открыть микрофон без «Джарвис» (на ~8 с)`);
  return accel;
}
