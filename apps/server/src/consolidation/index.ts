/**
 * Ночная консолидация памяти и навыков (§8) — скелет крона.
 *
 * Раз в сутки в простое: суммаризировать эпизоды дня, обновить долговременную
 * память, и аккуратно улучшить навыки на основе наблюдённых прогонов.
 *
 * ГРАНИЦЫ АВТОПРАВКИ НАВЫКОВ (§8) — критично, поэтому фиксируем контракт уже здесь:
 *  1. Шаги, помеченные `protected` (guard-шаги: подтверждения, проверки сумм,
 *     необратимые действия), консолидация НЕ трогает никогда.
 *  2. Изменение навыка создаёт НОВУЮ версию, а не правит текущую. Текущая остаётся
 *     боевой, пока новая не подтверждена.
 *  3. Новая версия становится дефолтной ТОЛЬКО после успешного прогона
 *     (shadow/в следующий раз отработала без эскалации).
 *  4. Rollback по fail_count: если новая версия накопила сбои выше порога —
 *     откат на предыдущую стабильную версию.
 *
 * Реализация — TODO(M4). Здесь интерфейс и заглушка, которая безопасно ничего
 * не делает (логирует намерение).
 */
import type { SkillStep } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { isGuardStep } from "../memory/skills.js";

const log: Logger = createLogger("consolidation");

/** Порог сбоев новой версии навыка для отката (§8). */
export const SKILL_ROLLBACK_FAIL_THRESHOLD = 2;

export interface ConsolidationResult {
  /** Сколько эпизодов суммаризировано. */
  episodesSummarized: number;
  /** Сколько навыков получили новую (неактивную пока) версию. */
  skillsRevised: number;
  /** Сколько навыков откатилось по fail_count. */
  skillsRolledBack: number;
}

/**
 * Ночной прогон консолидации для пользователя (§8).
 * TODO(M4): реальная суммаризация (Sonnet/Fable §7) + ревизия навыков
 * с соблюдением границ автоправки выше.
 */
export async function nightlyConsolidation(userId: string): Promise<ConsolidationResult> {
  log.info("nightlyConsolidation — заглушка (M4)", { userId });
  // Намеренно no-op: пока не трогаем навыки/память, чтобы не навредить (§8).
  await Promise.resolve();
  return { episodesSummarized: 0, skillsRevised: 0, skillsRolledBack: 0 };
}

/**
 * Решить, можно ли продвинуть новую версию навыка в дефолт (§8, правило 3).
 * Чистая функция — реальна и тестируема уже сейчас.
 */
export function canPromoteSkillVersion(params: {
  hadSuccessfulRun: boolean;
  newVersionFailCount: number;
}): boolean {
  return params.hadSuccessfulRun && params.newVersionFailCount < SKILL_ROLLBACK_FAIL_THRESHOLD;
}

/** Нужен ли откат версии по накопленным сбоям (§8, правило 4). */
export function shouldRollbackSkillVersion(failCount: number): boolean {
  return failCount >= SKILL_ROLLBACK_FAIL_THRESHOLD;
}

/**
 * Применить предложенную ревизию шагов с соблюдением границ автоправки (§8, правило 1):
 * позиции, где ТЕКУЩИЙ шаг — guard (message.send/order.place/code.run/powershell/confirm),
 * замораживаются и не заменяются. Новые не-guard шаги в конце добавляются.
 * Возвращает новый набор шагов и индексы заблокированных позиций.
 */
export function applySkillRevision(
  current: readonly SkillStep[],
  proposed: readonly SkillStep[],
): { steps: SkillStep[]; blockedIndices: number[] } {
  const blockedIndices: number[] = [];
  const steps: SkillStep[] = current.map((cur, i) => {
    if (isGuardStep(cur)) {
      blockedIndices.push(i);
      return cur; // §8: guard-шаг неприкосновенен для автоправки
    }
    return proposed[i] ?? cur;
  });
  for (let i = current.length; i < proposed.length; i += 1) {
    const p = proposed[i];
    if (p) steps.push(p); // добавление шага в конец допускается
  }
  return { steps, blockedIndices };
}
