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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DemoEvent, SkillStep } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { buildSkillDraft } from "./demo.js";
import { saveSkill } from "../../memory/skills.js";

const log: Logger = createLogger("skill-record");

/** Папка осязаемых SKILL.md на диске (рядом с рабочей директорией сервера). */
const SKILLS_DIR = join(process.cwd(), "data", "skills");

export interface SavedSkillSummary {
  id: string;
  name: string;
  version: number;
  steps: SkillStep[];
  needsReview: boolean;
  /** число значимых шагов (для голосового отчёта). */
  stepCount: number;
}

/** Кебаб-слаг из имени навыка (латиница/цифры; кириллица транслитерируется грубо). */
function slugify(name: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", " ": "-",
  };
  const slug = [...name.toLowerCase()]
    .map((ch) => (ch in map ? map[ch] : /[a-z0-9-]/.test(ch) ? ch : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "skill";
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
  try {
    await mkdir(SKILLS_DIR, { recursive: true });
    await writeFile(join(SKILLS_DIR, `${id}.md`), draft.contentMd, "utf8");
    log.info(`SKILL.md записан: ${join(SKILLS_DIR, `${id}.md`)}`);
  } catch (e) {
    log.warn(`не удалось записать SKILL.md на диск: ${e instanceof Error ? e.message : String(e)}`);
  }

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
