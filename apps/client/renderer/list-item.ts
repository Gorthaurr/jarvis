/**
 * Общая строка списка `<li class="skill">` (§ревью-дедуп) — раньше дублировалась в renderer.ts дважды
 * (список навыков ↔ список голосов): meta-блок (имя + опц. подпись) + кнопка действия. Сведено в одну
 * фабрику. className СОХРАНЁН ('skill'/'btn btn--{variant} btn--sm') для байт-в-байт DOM; переименование
 * .skill→.list-item — отдельная косметика. Лист-модуль (только document) → импорт односторонний.
 */
export function buildListItem(opts: {
  name: string;
  sub?: string;
  action: { label: string; variant: "ok" | "ghost"; onClick: () => void };
  dataId?: { attr: string; value: string };
}): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "skill";
  if (opts.dataId) li.dataset[opts.dataId.attr] = opts.dataId.value;

  const meta = document.createElement("div");
  meta.className = "skill__meta";
  const nameEl = document.createElement("span");
  nameEl.className = "skill__name";
  nameEl.textContent = opts.name;
  meta.appendChild(nameEl);
  if (opts.sub !== undefined) {
    const sub = document.createElement("span");
    sub.className = "skill__sub";
    sub.textContent = opts.sub;
    meta.appendChild(sub);
  }

  const btn = document.createElement("button");
  btn.className = `btn btn--${opts.action.variant} btn--sm`;
  btn.type = "button";
  btn.textContent = opts.action.label;
  btn.addEventListener("click", opts.action.onClick);

  li.appendChild(meta);
  li.appendChild(btn);
  return li;
}
