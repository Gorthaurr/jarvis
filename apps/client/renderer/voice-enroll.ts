/**
 * Запись голосовых отпечатков (§3 верификация диктора) — вынесено из god-file renderer.ts (§ревью).
 * Кнопка старт/отмена записи, прогресс, итог, список enrolled-голосов с удалением. jarvis — DI init.
 * Строка списка — через общий buildListItem (дедуп с навыками). Зависит только от jarvis + своих 4 DOM.
 */
import type { JarvisBridge } from "../main/ipc-contract.js";
import { $ } from "./dom.js";
import { buildListItem } from "./list-item.js";

const voiceName = $<HTMLInputElement>("voiceName");
const voiceEnrollBtn = $<HTMLButtonElement>("voiceEnrollBtn");
const voiceEnrollStatus = $("voiceEnrollStatus");
const voiceListEl = $("voiceList");
let enrolling = false;

function setEnrollBtn(active: boolean): void {
  enrolling = active;
  voiceEnrollBtn.textContent = active ? "Идёт запись… (отмена)" : "Записать голос";
  voiceEnrollBtn.classList.toggle("btn--accent", !active);
}

/** Инициализация записи голоса (§3): кнопка + прогресс/итог + список голосов. j — мост main (DI). */
export function initVoiceEnrollment(jarvis: JarvisBridge): void {
  voiceEnrollBtn.addEventListener("click", () => {
    if (enrolling) {
      jarvis.cancelVoiceEnroll();
      setEnrollBtn(false);
      voiceEnrollStatus.textContent = "Запись отменена.";
      return;
    }
    const name = voiceName.value.trim();
    if (!name) {
      voiceEnrollStatus.textContent = "Сначала введите имя голоса.";
      return;
    }
    jarvis.startVoiceEnroll(name);
    setEnrollBtn(true);
    voiceEnrollStatus.textContent = `Говорите… (${name})`;
  });

  jarvis.onVoiceEnrollProgress((p) => {
    if (enrolling) voiceEnrollStatus.textContent = `Запись… ${Math.round(p.percent * 100)}% — говорите ещё.`;
  });

  jarvis.onVoiceEnrollDone((d) => {
    setEnrollBtn(false);
    voiceEnrollStatus.textContent = d.ok ? `Готово — голос «${d.name}» записан.` : "Не удалось записать (мало речи?). Попробуйте ещё раз.";
    if (d.ok) voiceName.value = "";
  });

  // Список enrolled-голосов (с удалением). Пусто → подсказка.
  jarvis.onVoiceList((l) => {
    voiceListEl.replaceChildren();
    if (l.names.length === 0) {
      const empty = document.createElement("li");
      empty.className = "skill-list__empty";
      empty.textContent = "Пока нет записанных голосов — Джарвис слышит всех.";
      voiceListEl.appendChild(empty);
      return;
    }
    for (const name of l.names) {
      voiceListEl.appendChild(
        buildListItem({
          name,
          action: { label: "Удалить", variant: "ghost", onClick: () => jarvis.removeVoice(name) },
        }),
      );
    }
  });

  jarvis.listVoices(); // подтянуть текущие голоса при загрузке
}
