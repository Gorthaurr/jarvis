/**
 * КАТАЛОГ МОДЕЛЕЙ МОЗГА — единый источник для сервера (тарифы obs/pricing, allowlist планов, выбор по
 * тирам), клиента (селект «Модель» в настройках) и будущего LLM-прокси проекта.
 *
 * Зачем один каталог: до 2026-09-02 тариф резолвился подстрочным матчем `sonnet|opus|fable`, и
 * `claude-fable-5-1` считался по цене Opus ($5/$25 вместо $10/$50 — SpendGuard недоучитывал сильный тир
 * вдвое), а `claude-sonnet-5` — по цене 4.6 (×1.5). Здесь id ТОЧНЫЕ (без дат), цены — USD за 1M токенов
 * по прайсу Anthropic (справочник 2026-06-24). `cacheWrite` — запись кеша 5m TTL (1.25× входа); для 1h
 * (проект живёт на нём) ставка 2× входа считается в obs/pricing.cacheWriteRate.
 *
 * ВЫБОР МОДЕЛИ ПОЛЬЗОВАТЕЛЕМ (требование владельца 2026-09-02): `resolveTierModels` накладывает выбор
 * {primary, strong} на дефолтную лестницу тиров: primary → слоты haiku+sonnet (дефолт ходов), strong →
 * слот fable (эскалация §7). Неизвестный id или id вне allowlist плана — ОТКЛОНЯЕТСЯ с причиной, а не
 * подставляется молча (иначе пользователь думал бы, что работает на выбранной модели).
 */

export type ModelFamily = "sonnet" | "opus" | "fable" | "haiku";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCatalogEntry {
  /** Точный id модели в API Anthropic (без даты). */
  id: string;
  /** Человекочитаемое имя для UI. */
  label: string;
  family: ModelFamily;
  generation: string;
  price: ModelPrice;
  /** Роль по умолчанию: cheap — дефолт ходов, strong — эскалация. */
  role: "cheap" | "strong";
  /** Класс стоимости для планов: 1 дешёвый … 3 флагман. */
  costClass: 1 | 2 | 3;
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", family: "sonnet", generation: "4.6", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, role: "cheap", costClass: 1 },
  { id: "claude-sonnet-5", label: "Sonnet 5", family: "sonnet", generation: "5", price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, role: "cheap", costClass: 1 },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", family: "haiku", generation: "4.5", price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, role: "cheap", costClass: 1 },
  { id: "claude-opus-4-6", label: "Opus 4.6", family: "opus", generation: "4.6", price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, role: "strong", costClass: 2 },
  { id: "claude-opus-4-7", label: "Opus 4.7", family: "opus", generation: "4.7", price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, role: "strong", costClass: 2 },
  { id: "claude-opus-4-8", label: "Opus 4.8", family: "opus", generation: "4.8", price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, role: "strong", costClass: 2 },
  { id: "claude-opus-5", label: "Opus 5", family: "opus", generation: "5", price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, role: "strong", costClass: 2 },
  { id: "claude-fable-5", label: "Fable 5", family: "fable", generation: "5", price: { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 }, role: "strong", costClass: 3 },
  // Fable 5.1: чтение кеша по прайсу $0.25/MTok (не 0.1× входа) — справочник Anthropic 2026-06.
  { id: "claude-fable-5-1", label: "Fable 5.1", family: "fable", generation: "5.1", price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, role: "strong", costClass: 3 },
];

const BY_ID: ReadonlyMap<string, ModelCatalogEntry> = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

/** Запись каталога по ТОЧНОМУ id (регистр игнорируется, дата-суффикс не понимается — id без дат). */
export function findModel(id: string): ModelCatalogEntry | undefined {
  return BY_ID.get((id || "").trim().toLowerCase());
}

export function isKnownModel(id: string): boolean {
  return findModel(id) !== undefined;
}

/** Выбор модели пользователем: пусто/undefined = «авто» (дефолтная лестница тиров). */
export interface ModelChoiceLike {
  primary?: string;
  strong?: string;
}

/** Модели по тирам (слоты исторически haiku/sonnet/fable, см. DEFAULT_MODELS). */
export interface TierModels {
  haiku: string;
  sonnet: string;
  fable: string;
}

export interface RejectedChoice {
  slot: "primary" | "strong";
  id: string;
  reason: "unknown" | "not_allowed";
}

export interface ResolvedModels {
  models: TierModels;
  /** Что реально применилось (undefined = дефолт). */
  primary?: string;
  strong?: string;
  rejected: RejectedChoice[];
  /** Дефолт ходов и эскалация — одна модель: каскад §7 работать не будет (см. boot-WARN сервера). */
  collapsed: boolean;
  /** Сильный слот ДЕШЕВЛЕ основного (обе модели известны каталогу): эскалация §7 ответ не усилит. */
  downgrade: boolean;
}

function costClassOf(id: string): number {
  return MODEL_CATALOG.find((m) => m.id === id)?.costClass ?? 0;
}

/**
 * Наложить выбор пользователя на дефолтную лестницу тиров.
 * `allowed` — allowlist плана (null/undefined = любой id из каталога). Отклонённые слоты остаются
 * дефолтными и перечисляются в `rejected` — вызывающий обязан показать это пользователю.
 */
export function resolveTierModels(
  defaults: TierModels,
  choice: ModelChoiceLike | undefined,
  allowed?: ReadonlySet<string> | null,
): ResolvedModels {
  const models: TierModels = { ...defaults };
  const rejected: RejectedChoice[] = [];
  const pick = (slot: "primary" | "strong", raw: string | undefined): string | undefined => {
    const id = (raw ?? "").trim().toLowerCase();
    if (!id) return undefined;
    if (!isKnownModel(id)) {
      rejected.push({ slot, id, reason: "unknown" });
      return undefined;
    }
    if (allowed && !allowed.has(id)) {
      rejected.push({ slot, id, reason: "not_allowed" });
      return undefined;
    }
    return id;
  };
  const primary = pick("primary", choice?.primary);
  const strong = pick("strong", choice?.strong);
  if (primary) {
    models.haiku = primary;
    models.sonnet = primary;
  }
  if (strong) models.fable = strong;
  // 🔴 Тарифный allowlist обязан ограничивать и ДЕФОЛТНУЮ лестницу, а не только явный выбор (живой
  // прогон 2026-09-02: план разрешал Sonnet, панель писала «Opus недоступна на тарифе», а эскалация §7
  // молча уходила на claude-opus-4-8 — пользователю сказали неправду, владельцу выставили счёт вдвое).
  // Слот с недопустимой дефолтной моделью заменяется на лучшую разрешённую СВОЕЙ роли; нет такой —
  // на лучшую разрешённую вообще (тогда сильный слот совпадёт со слабым, и `collapsed` это честно
  // покажет). allowed=null (дев-режим/без квот) — ничего не трогаем, поведение прежнее.
  if (allowed) {
    const pool = MODEL_CATALOG.filter((m) => allowed.has(m.id));
    const bestOf = (role: "cheap" | "strong"): string | undefined => {
      const byRole = pool.filter((m) => m.role === role);
      return [...(byRole.length > 0 ? byRole : pool)].sort((a, b) => b.costClass - a.costClass)[0]?.id;
    };
    const cheap = bestOf("cheap");
    const strongest = bestOf("strong");
    if (cheap) {
      if (!allowed.has(models.haiku)) models.haiku = cheap;
      if (!allowed.has(models.sonnet)) models.sonnet = cheap;
    }
    if (strongest && !allowed.has(models.fable)) models.fable = strongest;
  }
  const cs = costClassOf(models.sonnet);
  const cf = costClassOf(models.fable);
  return { models, primary, strong, rejected, collapsed: models.sonnet === models.fable, downgrade: cs > 0 && cf > 0 && cf < cs };
}
