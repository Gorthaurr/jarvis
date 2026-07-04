/**
 * Модалка записи навыка демонстрацией (§8 HERMES) — вынесено из god-file renderer.ts (§ревью).
 * Setup→запись→готово/отмена, счётчик показанных шагов, список записанных навыков с «▶ Повторить».
 * jarvis — DI init; панель настроек прячется через DI-коллбэк closeSettings (без импорта SettingsPanel →
 * нет связи кластеров). Экспортирует isSkillOpen/cancelSkillModal для глобального ESC-хендлера.
 * Строка списка — общий buildListItem (дедуп с голосами). focus-trap — общий a11y-хаб.
 */
import type { JarvisBridge } from "../main/ipc-contract.js";
import { $ } from "./dom.js";
import { rememberFocus, restoreFocus } from "./focus-trap.js";
import { buildListItem } from "./list-item.js";

const makeSkillBtn = $<HTMLButtonElement>("makeSkillBtn");
const skillOverlay = $("skillOverlay");
const skillSetup = $("skillSetup");
const skillRecording = $("skillRecording");
const skillName = $<HTMLInputElement>("skillName");
const skillCountEl = $("skillCount");
const skillLastEl = $("skillLast");
const skillStartBtn = $<HTMLButtonElement>("skillStartBtn");
const skillDoneBtn = $<HTMLButtonElement>("skillDoneBtn");
const skillCancelBtn = $<HTMLButtonElement>("skillCancelBtn");
const skillList = $("skillList");

let recording = false;
/** DI: прячет панель настроек (foundation в renderer), чтобы модалка её не перекрывала. */
let closeSettings: () => void = () => {};

/** Сбросить модалку записи в исходный (до старта) вид. */
function resetSkillModal(): void {
  recording = false;
  skillSetup.classList.remove("overlay--hidden");
  skillRecording.classList.add("overlay--hidden");
  skillStartBtn.classList.remove("overlay--hidden");
  skillDoneBtn.classList.add("overlay--hidden");
  skillCountEl.textContent = "0";
  skillLastEl.textContent = "";
}

function openSkillModal(): void {
  resetSkillModal();
  skillName.value = "";
  closeSettings(); // не перекрывать модалкой панель настроек
  rememberFocus();
  skillOverlay.classList.remove("overlay--hidden");
  skillName.focus(); // фокус в поле имени навыка
}

function closeSkillModal(): void {
  skillOverlay.classList.add("overlay--hidden");
  resetSkillModal();
  restoreFocus();
}

/** Открыта ли модалка записи — для глобального ESC-хендлера (без доступа к её DOM). */
export function isSkillOpen(): boolean {
  return !skillOverlay.classList.contains("overlay--hidden");
}
/** Отмена записи (ESC/программно) — эквивалент кнопки «Отмена». */
export function cancelSkillModal(): void {
  skillCancelBtn.click();
}

/** Инициализация записи навыка (§8). j — мост main; onCloseSettings прячет панель настроек (DI). */
export function initSkillRecorder(j: JarvisBridge, onCloseSettings: () => void): void {
  closeSettings = onCloseSettings;

  // Клик по затемнению вне окна навыка = отмена (как кнопка «Отмена»).
  skillOverlay.addEventListener("click", (e) => {
    if (e.target === skillOverlay) skillCancelBtn.click();
  });

  makeSkillBtn.addEventListener("click", openSkillModal);

  skillStartBtn.addEventListener("click", () => {
    // Сворачиваем окно Джарвиса, чтобы пользователь показывал задачу в своих приложениях.
    j.startSkill(skillName.value);
  });

  skillDoneBtn.addEventListener("click", () => {
    j.stopSkill();
    closeSkillModal();
  });

  skillCancelBtn.addEventListener("click", () => {
    if (recording) j.cancelSkill();
    closeSkillModal();
  });

  // Состояние записи из main: переключаем вид и обновляем счётчик.
  j.onSkillState((s) => {
    if (s.unavailable) {
      skillLastEl.textContent = "Запись недоступна — не запущен системный модуль (sidecar).";
      return;
    }
    recording = s.recording;
    if (s.recording) {
      skillSetup.classList.add("overlay--hidden");
      skillRecording.classList.remove("overlay--hidden");
      skillStartBtn.classList.add("overlay--hidden");
      skillDoneBtn.classList.remove("overlay--hidden");
    }
    skillCountEl.textContent = String(s.count);
    if (s.last) skillLastEl.textContent = s.last;
  });

  // Навык записан/прислан сервером — добавляем строку с кнопкой повтора.
  j.onSkillSaved((s) => {
    const empty = skillList.querySelector(".skill-list__empty");
    if (empty) empty.remove();
    // не дублируем при повторной записи того же id
    const existing = skillList.querySelector(`[data-skill-id="${s.id}"]`);
    existing?.remove();
    skillList.appendChild(
      buildListItem({
        name: s.name,
        sub: `${s.steps.length} шагов${s.needsReview ? " · нужно ревью" : ""}`,
        action: { label: "▶ Повторить", variant: "ok", onClick: () => j.runSkill(s.id) },
        dataId: { attr: "skillId", value: s.id },
      }),
    );
  });
}
