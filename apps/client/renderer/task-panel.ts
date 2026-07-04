/**
 * Док чипов задач (§20) — вынесено из god-file renderer.ts (§ревью). По компактному чипу на активную
 * задачу (параллельные видны разом): прогресс-бар, кнопки пауза/продолжить/стоп (адресуют ИМЕННО свою
 * задачу), автоскрытие терминального чипа. Состояние (2 Map) приватно кластеру. jarvis/taskDock —
 * через init (DI). Тип TaskStatus — type-only из @jarvis/protocol (стирается, цикла нет).
 */
import type { TaskStatus } from "@jarvis/protocol";
import type { JarvisBridge } from "../main/ipc-contract.js";
import { $ } from "./dom.js";

let jarvis: JarvisBridge;
let taskDock: HTMLElement;
/** taskId → DOM-чип задачи. */
const taskChips = new Map<string, HTMLElement>();
/** taskId → таймер автоскрытия терминального чипа. */
const chipHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

const TASK_STATE_RU: Record<TaskStatus["state"], string> = {
  queued: "в очереди",
  running: "выполняю",
  paused: "на паузе",
  waiting_confirm: "жду",
  done: "готово",
  failed: "ошибка",
  cancelled: "отменено",
};

const TERMINAL_STATES: ReadonlySet<TaskStatus["state"]> = new Set(["done", "failed", "cancelled"]);

/** Создать DOM-чип задачи. Кнопки адресуют команды ИМЕННО этой задаче (taskId в замыкании). */
function buildTaskChip(taskId: string): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "taskchip";
  chip.dataset.taskId = taskId;
  // Статичная разметка (без пользовательских данных — текст ставим через textContent ниже).
  chip.innerHTML = `
    <div class="taskchip__row">
      <span class="taskchip__state"></span>
      <span class="taskchip__title"></span>
    </div>
    <div class="taskchip__meta taskchip--hidden">
      <span class="taskchip__step"></span>
      <span class="taskchip__pct"></span>
    </div>
    <div class="taskchip__bar" role="progressbar"><div class="taskchip__bar-fill"></div></div>
    <div class="taskchip__actions">
      <button class="taskchip__btn taskchip__btn--ghost" data-act="pause" type="button">Пауза</button>
      <button class="taskchip__btn taskchip__btn--ok taskchip--hidden" data-act="resume" type="button">Продолжить</button>
      <button class="taskchip__btn taskchip__btn--deny" data-act="cancel" type="button">Стоп</button>
    </div>`;
  for (const btn of chip.querySelectorAll<HTMLButtonElement>(".taskchip__btn")) {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act as "pause" | "resume" | "cancel";
      jarvis.sendTaskControl(act, taskId);
    });
  }
  taskDock.appendChild(chip);
  return chip;
}

/** Отрисовать прогресс/состояние ОДНОЙ задачи в её чипе (§20). Параллельные — отдельные чипы. */
function renderTaskStatus(s: TaskStatus): void {
  const pending = chipHideTimers.get(s.taskId);
  if (pending) {
    clearTimeout(pending);
    chipHideTimers.delete(s.taskId);
  }

  let chip = taskChips.get(s.taskId);
  if (!chip) {
    chip = buildTaskChip(s.taskId);
    taskChips.set(s.taskId, chip);
  }

  chip.className = `taskchip taskchip--${s.state}`;
  const stateEl = chip.querySelector<HTMLElement>(".taskchip__state");
  if (stateEl) stateEl.textContent = TASK_STATE_RU[s.state] ?? s.state;
  const titleEl = chip.querySelector<HTMLElement>(".taskchip__title");
  if (titleEl) {
    titleEl.textContent = s.title ?? s.summary ?? "";
    titleEl.title = s.summary ?? ""; // полная формулировка — в тултип
  }

  const fill = chip.querySelector<HTMLElement>(".taskchip__bar-fill");
  const bar = chip.querySelector<HTMLElement>(".taskchip__bar");
  const meta = chip.querySelector<HTMLElement>(".taskchip__meta");
  const stepEl = chip.querySelector<HTMLElement>(".taskchip__step");
  const pctEl = chip.querySelector<HTMLElement>(".taskchip__pct");
  // доступное имя прогресс-бара (a11y) — формулировка задачи.
  bar?.setAttribute("aria-label", s.title ?? s.summary ?? "задача");
  if (fill) {
    if (s.stepsTotal && s.stepsTotal > 0) {
      const done = s.stepsDone ?? 0;
      const pct = Math.min(100, Math.round((done / s.stepsTotal) * 100));
      fill.style.width = `${pct}%`;
      fill.classList.remove("taskchip__bar-fill--indeterminate");
      // мета-строка как в макете: «Шаг N из M» + «NN%» (+ aria-valuenow для скринридера).
      if (stepEl) stepEl.textContent = `Шаг ${done} из ${s.stepsTotal}`;
      if (pctEl) pctEl.textContent = `${pct}%`;
      meta?.classList.remove("taskchip--hidden");
      bar?.setAttribute("aria-valuenow", String(pct));
      bar?.setAttribute("aria-valuemin", "0");
      bar?.setAttribute("aria-valuemax", "100");
    } else {
      fill.style.width = "100%";
      fill.classList.add("taskchip__bar-fill--indeterminate");
      meta?.classList.add("taskchip--hidden"); // нет шагов → индетерминантный бар без чисел
      bar?.removeAttribute("aria-valuenow");
    }
  }

  const terminal = TERMINAL_STATES.has(s.state);
  const paused = s.state === "paused";
  const toggle = (sel: string, hidden: boolean): void => {
    chip?.querySelector<HTMLElement>(sel)?.classList.toggle("taskchip--hidden", hidden);
  };
  toggle('[data-act="cancel"]', terminal);
  toggle('[data-act="pause"]', terminal || paused);
  toggle('[data-act="resume"]', terminal || !paused);

  if (terminal) {
    fill?.classList.remove("taskchip__bar-fill--indeterminate");
    // Показать итог пару секунд, затем убрать ИМЕННО этот чип (остальные живут).
    const timer = setTimeout(() => {
      taskChips.get(s.taskId)?.remove();
      taskChips.delete(s.taskId);
      chipHideTimers.delete(s.taskId);
    }, 4000);
    chipHideTimers.set(s.taskId, timer);
  }
}

/** Инициализация дока задач: захват #taskDock + подписка на task.status (§20). j — мост main (DI). */
export function initTaskPanel(j: JarvisBridge): void {
  jarvis = j;
  taskDock = $("taskDock");
  jarvis.onTaskStatus((s: TaskStatus) => renderTaskStatus(s));
}
