/**
 * Детерминированный RU-нарратор задач (§20).
 *
 * Превращает состояние долгой задачи в короткие реплики ассистента: анонс старта,
 * вехи прогресса, ответ на «что делаешь», финальный отчёт и сообщение об ошибке.
 *
 * Принципы §20:
 *  - анонсируем и резюмируем только ДОЛГИЕ задачи (порог NARRATE_THRESHOLD_MS);
 *  - тексты короткие, спокойные, по делу — в характере ассистента;
 *  - ошибка озвучивается как краткая причина + ОДНО следующее действие,
 *    подробности (lastError) уходят в display-карточку, а не в голос;
 *  - пользовательские строки (цель, итог) проходят через verbalize(), чтобы
 *    в TTS не попали markdown/emoji/url.
 *
 * Всё детерминированно: ни сети, ни LLM, ни системных часов в логике текста.
 */
import { pluralRu, verbalize } from "../verbalize/index.js";
import type { Task } from "./task.js";
import { NARRATE_THRESHOLD_MS } from "./task.js";

// ── анонс старта ─────────────────────────────────────────────

/**
 * Нужно ли анонсировать начало задачи голосом (§20).
 * Анонсируем, если ожидаемая длительность ≥ порога нарративности — короткие
 * задачи выполняются молча, чтобы не засорять диалог.
 */
export function shouldAnnounce(estimatedMs: number): boolean {
  return estimatedMs >= NARRATE_THRESHOLD_MS;
}

/**
 * Анонс начала долгой задачи (§20): «Секунду, делаю: <goal>.».
 * Цель прогоняется через verbalize() — в голос не должен попасть markdown/emoji.
 */
export function announceTask(goal: string): string {
  const spoken = verbalize(goal);
  return `Секунду, делаю: ${spoken}.`;
}

// ── вехи прогресса ───────────────────────────────────────────

/**
 * Реплика-веха о текущем шаге (§20).
 *  - с известным total: «Шаг N из M: <label>» (плюрализация «шаг/шага/шагов»);
 *  - без total (open-ended LLM-петля): «<label>…», а без label — «Готовлю…».
 *
 * stepsDone трактуем как номер текущего/завершённого шага для согласования формы.
 */
export function milestoneLine(
  stepsDone: number,
  stepsTotal?: number,
  label?: string,
): string {
  const spokenLabel = label ? verbalize(label) : "";

  if (stepsTotal !== undefined) {
    // «Шаг N из M» — фиксированная форма (не плюрализуем по N: «Шагов 5 из 40» грамматически неверно).
    const head = `Шаг ${stepsDone} из ${stepsTotal}`;
    return spokenLabel ? `${head}: ${spokenLabel}` : `${head}.`;
  }

  // Открытая петля без total — просто что делаем сейчас.
  if (spokenLabel) return `${spokenLabel}…`;
  return "Готовлю…";
}

// ── ответ на «что делаешь» ───────────────────────────────────

/**
 * Отчёт о текущем состоянии задачи (§20, реакция на «что делаешь»/«как там»).
 * Покрывает: running с прогрессом, paused, отсутствие stepsTotal, терминальные.
 */
export function statusReport(task: Task): string {
  const goal = verbalize(task.goal);

  switch (task.state) {
    case "paused":
      return `На паузе: ${goal}. ${progressPhrase(task)} Скажите «продолжи», когда нужно.`;

    case "waiting_confirm":
      return `Жду подтверждения по задаче: ${goal}. ${progressPhrase(task)}`;

    case "queued":
      return `В очереди: ${goal}. Пока не начал.`;

    case "running":
      return `Делаю: ${goal}. ${progressPhrase(task)}`;

    case "done":
      return `Уже готово: ${goal}.`;

    case "failed":
      return `Не получилось: ${goal}.`;

    case "cancelled":
      return `Отменено: ${goal}.`;

    default:
      return `Делаю: ${goal}. ${progressPhrase(task)}`;
  }
}

/**
 * Фраза о прогрессе для statusReport.
 *  - есть total: «Шаг N из M.» с плюрализацией;
 *  - нет total, но что-то сделано: «Сделал(а) N шаг/шага/шагов.»;
 *  - ещё ничего: «Только начал.».
 */
function progressPhrase(task: Task): string {
  const { stepsDone, stepsTotal } = task;

  if (stepsTotal !== undefined) {
    return `Шаг ${stepsDone} из ${stepsTotal}.`;
  }
  if (stepsDone > 0) {
    const word = pluralRu(stepsDone, ["шаг", "шага", "шагов"]);
    return `Сделал ${stepsDone} ${word}.`;
  }
  return "Только начал.";
}

// ── финальный отчёт ──────────────────────────────────────────

/**
 * Краткий отчёт по завершении (§20). Если у задачи есть resultSummary —
 * озвучиваем его (через verbalize), иначе короткое «Готово.».
 */
export function finalReport(task: Task): string {
  if (task.resultSummary && task.resultSummary.trim() !== "") {
    return verbalize(task.resultSummary);
  }
  return "Готово.";
}

// ── отчёт об ошибке ──────────────────────────────────────────

/**
 * Отчёт об ошибке (§20): голос = краткая причина + ОДНО следующее действие
 * («…не вышло. Попробовать ещё раз?»). Технические детали (lastError) идут
 * в display-карточку, а не в голос.
 */
export function errorReport(task: Task): {
  voice: string;
  display?: { title?: string; markdown: string };
} {
  const goal = verbalize(task.goal);
  const voice = `${goal} — не вышло. Попробовать ещё раз?`;

  const detail = task.lastError?.trim();
  if (!detail) {
    return { voice };
  }

  return {
    voice,
    display: {
      title: "Не удалось выполнить задачу",
      markdown: `**${task.goal}**\n\nОшибка: ${detail}`,
    },
  };
}
