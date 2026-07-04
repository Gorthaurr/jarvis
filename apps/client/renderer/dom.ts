/**
 * Общий DOM-хелпер для renderer-модулей (§ревью-вынос god-object renderer.ts). `#id` → элемент,
 * бросает, если элемента нет (контракт renderer: разметка фиксирована index.html, отсутствие = баг).
 * Лист-модуль (ни от чего не зависит) → импортируется и renderer.ts, и вынесенными панелями без цикла.
 */
export const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`нет элемента #${id}`);
  return el as T;
};
