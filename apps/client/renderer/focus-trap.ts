/**
 * Фокус-менеджмент модалок (a11y) — вынесено из god-file renderer.ts (§ревью). Общий хаб для
 * ConfirmDialog и SkillRecorder: запомнить активный элемент перед открытием модалки (rememberFocus),
 * вернуть на него фокус при закрытии (restoreFocus). Лист-модуль (только document) → импортируется
 * обоими модальными кластерами односторонне, цикл невозможен.
 */
let lastFocused: HTMLElement | null = null;

export function rememberFocus(): void {
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export function restoreFocus(): void {
  lastFocused?.focus();
  lastFocused = null;
}
