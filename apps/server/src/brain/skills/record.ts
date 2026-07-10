/**
 * Сохранение навыка, записанного демонстрацией (§8).
 *
 * Вход — батч UIA-событий из sidecar-хука + имя от пользователя. Здесь:
 *   1) buildSkillDraft — детерминированный черновик SKILL.md (роли/имена, НЕ координаты);
 *   2) saveSkill — персист в БД (источник истины — content_md);
 *   3) дублируем SKILL.md на диск (data/skills/<id>.md) — осязаемый артефакт «Джарвис запомнил».
 *
 * Возвращает сводку для проброса в UI (skill.saved) и голосового подтверждения.
 */
import type { DemoEvent, SkillStep } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { buildSkillDraft } from "./demo.js";
import { saveSkill, slugify, writeSkillFile } from "../../memory/skills.js";

const log: Logger = createLogger("skill-record");

export interface SavedSkillSummary {
  id: string;
  name: string;
  version: number;
  steps: SkillStep[];
  needsReview: boolean;
  /** число значимых шагов (для голосового отчёта). */
  stepCount: number;
}

/**
 * Построить и сохранить навык из демонстрации (§8).
 * id детерминирован из имени; при повторной записи того же имени — это новая версия
 * (saveSkill делает upsert по (id, user_id)).
 */
export async function saveDemonstratedSkill(
  userId: string,
  params: { name: string; events: readonly DemoEvent[]; commentary?: string },
): Promise<SavedSkillSummary | null> {
  const name = params.name.trim() || "Навык";
  const id = slugify(name);

  const draft = buildSkillDraft({
    id,
    name,
    events: params.events,
    ...(params.commentary ? { commentary: params.commentary } : {}),
  });

  if (draft.steps.length === 0) {
    log.warn(`демонстрация «${name}» не содержит значимых шагов — не сохраняем`);
    return null;
  }

  const record = await saveSkill(userId, draft.contentMd);
  const version = record?.version ?? 1;

  // Осязаемый артефакт на диске — пользователь может открыть и увидеть, что Джарвис запомнил.
  await writeSkillFile(id, draft.contentMd);

  log.info(`навык «${name}» (${id}) сохранён: ${draft.steps.length} шагов, review=${draft.needsReview}`);
  return {
    id,
    name,
    version,
    steps: draft.steps,
    needsReview: draft.needsReview,
    stepCount: draft.steps.length,
  };
}
