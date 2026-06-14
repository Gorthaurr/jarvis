/**
 * Обучение демонстрацией («смотри, покажу», §8).
 *
 * Клиент по команде пишет UIA-события (DemoEvent: роль/имя + действие — НЕ координаты)
 * и голосовой комментарий. Здесь — детерминированная конвертация событий в ЧЕРНОВИК
 * SkillStep[]/SKILL.md. Дальше Fable (§7) уточняет черновик по комментарию, а скилл
 * с guard-шагами проходит обязательное ревью пользователя перед первым применением (§14).
 */
import type { DemoEvent, SkillStep, UiPattern } from "@jarvis/protocol";
import { hasGuardSteps, serializeSkill } from "../../memory/skills.js";

/** Маппинг действия демонстрации на UIA-паттерн (§6). */
function patternFor(action: string): UiPattern | null {
  switch (action.toLowerCase()) {
    case "invoke":
    case "click":
    case "press":
      return "invoke";
    case "toggle":
      return "toggle";
    case "select":
      return "select";
    case "expand":
    case "collapse":
      return "expand";
    case "scroll":
      return "scroll";
    case "setvalue":
    case "settext":
      return "setValue";
    default:
      return null;
  }
}

/**
 * Конвертировать записанные UIA-события в черновик шагов (§8).
 * Действие по роли/имени → ui.invoke с подходящим паттерном; ввод текста → input.type.
 * Каждый шаг получает expect (role+name) как постусловие auto-wait (§6).
 */
export function demoEventsToSteps(events: readonly DemoEvent[]): SkillStep[] {
  const steps: SkillStep[] = [];
  for (const ev of events) {
    const a = ev.action.toLowerCase();
    if (a === "settext" || a === "type") {
      steps.push({
        action: "input.type",
        target: { by: "role", role: ev.role, ...(ev.name ? { name: ev.name } : {}) },
        ...(ev.name ? { expect: { role: ev.role, name: ev.name } } : {}),
      });
      continue;
    }
    const pattern = patternFor(a);
    if (!pattern) continue; // незначимое событие (hover/focus) пропускаем
    steps.push({
      action: "ui.invoke",
      target: { by: "role", role: ev.role, ...(ev.name ? { name: ev.name } : {}) },
      params: { pattern },
      ...(ev.name ? { expect: { role: ev.role, name: ev.name } } : {}),
    });
  }
  return steps;
}

export interface SkillDraft {
  contentMd: string;
  steps: SkillStep[];
  /** Требует ревью пользователя до первого применения (есть guard-шаги, §14). */
  needsReview: boolean;
}

/**
 * Собрать черновик SKILL.md из демонстрации + комментария (§8).
 * Комментарий идёт в description (Fable использует его при доводке). Это ДЕТЕРМИНИРОВАННЫЙ
 * скелет; реальная доводка формулировок/needsLlm-шагов — Fable-сессией (§7), затем ревью.
 */
export function buildSkillDraft(params: {
  id: string;
  name: string;
  events: readonly DemoEvent[];
  commentary?: string;
}): SkillDraft {
  const steps = demoEventsToSteps(params.events);
  const contentMd = serializeSkill(
    {
      id: params.id,
      name: params.name,
      version: 1,
      grounding: "a11y",
      ...(params.commentary ? { description: params.commentary } : {}),
      source: "demonstration",
    },
    steps,
  );
  return { contentMd, steps, needsReview: hasGuardSteps(steps) };
}
