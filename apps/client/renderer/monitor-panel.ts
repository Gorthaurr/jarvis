/**
 * Панель выбора рабочего монитора Джарвиса (§6 мультимонитор) — вынесено из god-file renderer.ts (§ревью).
 * Чистая фабрика строки-монитора + подписка jarvis.onMonitors + первичный listMonitors. jarvis передаётся
 * аргументом init (DI, НЕ импорт window), #monitorList берётся общим `$` → импорт обратно односторонний, без цикла.
 */
import type { JarvisBridge } from "../main/ipc-contract.js";
import { $ } from "./dom.js";

function monitorRow(label: string, sub: string, checked: boolean, onPick: () => void): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "monitor";
  const row = document.createElement("label");
  row.className = "monitor__row";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "jarvisMonitor";
  radio.className = "monitor__radio";
  radio.checked = checked;
  radio.addEventListener("change", () => {
    if (radio.checked) onPick();
  });
  const text = document.createElement("span");
  text.className = "monitor__text";
  const name = document.createElement("span");
  name.className = "monitor__name";
  name.textContent = label;
  text.appendChild(name);
  if (sub) {
    const tag = document.createElement("span");
    tag.className = "monitor__tag";
    tag.textContent = sub;
    text.appendChild(tag);
  }
  row.appendChild(radio);
  row.appendChild(text);
  li.appendChild(row);
  return li;
}

/** Подписка на список мониторов + первичный запрос (§6). jarvis — мост main (DI). */
export function initMonitorPanel(jarvis: JarvisBridge): void {
  const monitorListEl = $("monitorList");

  jarvis.onMonitors((l) => {
    monitorListEl.replaceChildren();
    // «Авто» — Джарвис сам выбирает вторичный (не основной пользователя).
    monitorListEl.appendChild(
      monitorRow("Авто (вторичный)", "Джарвис сам выберет не-основной экран", l.jarvisIndex === null, () =>
        jarvis.assignMonitor(null),
      ),
    );
    for (const m of l.monitors) {
      const sub = m.isJarvis ? "рабочий Джарвиса" : m.isPrimary ? "ваш основной" : "";
      monitorListEl.appendChild(
        monitorRow(m.label, sub, l.jarvisIndex === m.index, () => jarvis.assignMonitor(m.index)),
      );
    }
    if (l.monitors.length < 2) {
      const hint = document.createElement("li");
      hint.className = "skill-list__empty";
      hint.textContent = "Подключён один монитор — выбор появится при втором экране.";
      monitorListEl.appendChild(hint);
    }
  });

  jarvis.listMonitors(); // подтянуть мониторы при загрузке
}
