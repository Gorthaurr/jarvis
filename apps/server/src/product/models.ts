/**
 * ВЫБОР МОДЕЛИ ПОЛЬЗОВАТЕЛЕМ (требование владельца 2026-09-02: «модель, на которой всё работает,
 * пользователь должен иметь возможность сам выбирать»).
 *
 * Слой между профилем (что пользователь ПОПРОСИЛ — `UserProfile.models`) и лестницей тиров агента (что
 * РЕАЛЬНО применилось — `TierModels`). Резолв — чистая `resolveTierModels` из @jarvis/shared: primary →
 * слоты haiku+sonnet (дефолт ходов), strong → fable (эскалация §7). Неизвестный id или id вне allowlist
 * плана ОТКЛОНЯЕТСЯ с причиной, слот остаётся дефолтным, а `buildModelsCatalog` несёт отказ в UI
 * (`ModelsCatalog.rejected`): пользователь видит, что применилось, а не думает, что работает на выбранной.
 *
 * Здесь НЕТ env и IO: профиль читается синхронно из кеша (`getProfile`), allowlist приходит аргументом
 * (dev-режим: null = любая модель каталога; продукт: из плана). Проводка — router-ws/server.ts.
 */
import type { ModelChoice, ModelsCatalog } from "@jarvis/protocol";
import { MODEL_CATALOG, type ResolvedModels, type TierModels, resolveTierModels } from "@jarvis/shared";
import { getProfile } from "../brain/profile.js";

/** Нормализованный id: trim + lower (каталог сравнивает без учёта регистра); пусто → undefined. */
function normId(raw: string | undefined): string | undefined {
  const id = (raw ?? "").trim().toLowerCase();
  return id ? id : undefined;
}

/** Нормализовать выбор: пустые/пробельные слоты выпадают («пусто» в UI и профиле = авто). */
export function normalizeChoice(choice: ModelChoice | undefined): ModelChoice {
  const primary = normId(choice?.primary);
  const strong = normId(choice?.strong);
  return { ...(primary ? { primary } : {}), ...(strong ? { strong } : {}) };
}

/** Выбор модели пользователя из профиля (кеш; незагруженный раздел → «авто»). */
export function modelChoiceFor(userId: string): ModelChoice {
  return normalizeChoice(getProfile(userId).models);
}

/**
 * Allowlist плана как множество. null/undefined = ограничений нет (любой id каталога). ПУСТОЙ список —
 * это ПУСТОЕ множество (план не разрешает ничего сверх дефолта), а не «любая»: молчаливое расширение прав
 * из-за пустого поля — ровно тот класс ошибок, которого продуктовая политика избегает.
 */
export function allowedSetFrom(list: readonly string[] | null | undefined): ReadonlySet<string> | null {
  if (list === null || list === undefined) return null;
  const out = new Set<string>();
  for (const raw of list) {
    const id = normId(raw);
    if (id) out.add(id);
  }
  return out;
}

/** Модели по тирам для ЭТОГО пользователя: дефолтная лестница + его выбор (отказы — в `rejected`). */
export function effectiveModelsFor(
  defaults: TierModels,
  userId: string,
  allowed: ReadonlySet<string> | null,
): ResolvedModels {
  return resolveTierModels(defaults, modelChoiceFor(userId), allowed);
}

/**
 * Снимок для настроек «Общее» (сообщение `models.catalog`): каталог для селектов, что выбрано, что
 * применилось, allowlist плана (null = любая) и отклонённые с причиной — UI обязан их показать, не молчать.
 */
export function buildModelsCatalog(
  defaults: TierModels,
  choice: ModelChoice | undefined,
  allowed: readonly string[] | null,
): ModelsCatalog {
  const chosen = normalizeChoice(choice);
  const allowedSet = allowedSetFrom(allowed);
  const r = resolveTierModels(defaults, chosen, allowedSet);
  return {
    catalog: MODEL_CATALOG.map((m) => ({ id: m.id, label: m.label, family: m.family, role: m.role, costClass: m.costClass })),
    chosen,
    effective: { primary: r.models.sonnet, strong: r.models.fable },
    allowed: allowedSet ? [...allowedSet] : null,
    rejected: r.rejected.map((x) => ({ slot: x.slot, id: x.id, reason: x.reason })),
    downgrade: r.downgrade,
    collapsed: r.collapsed,
  };
}
