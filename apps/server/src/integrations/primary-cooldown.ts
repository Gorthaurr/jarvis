/**
 * Пауза полуоткрытого предохранителя основного канала (API по ключу) после подряд отказов и её досрочное снятие —
 * вынесено из fallback-llm.ts. Мотив паузы — СКОРОСТЬ: не тратить секунды хода на заведомо мёртвый HTTP-запрос.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { ApiFailureKind } from "./api-error-classify.js";

const log: Logger = createLogger("llm:fallback");

/**
 * Общая пауза (мс), `JARVIS_PRIMARY_COOLDOWN_MS`, деф 5 мин; 0 — предохранитель выключен.
 * Пустая строка → дефолт (та же грабля, что у перепроверки: Number("") === 0 обнулял бы паузу и возвращал
 * обречённые вызовы каждым ходом).
 */
function breakerCooldownMs(): number {
  const raw = (process.env.JARVIS_PRIMARY_COOLDOWN_MS ?? "").trim();
  if (!raw) return 300_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
}

/**
 * Гео-блок (403 «Request not allowed» без VPN, C3) — транзиентный, но не минутный: пока VPN не поднят, общая
 * 5-минутная пауза давала по 2 заведомо мёртвых вызова в каждое окно (адверс-ревью р1). Латчем (как баланс/ключ)
 * не делаем: VPN поднимется сам, и полуоткрытая проба это увидит. Нового флага нет — берём не меньше общей паузы.
 */
const REGION_COOLDOWN_MS = 30 * 60_000;

/** Пауза для последнего отказа: region — не короче 30 мин; 0 (предохранитель выключен владельцем) — 0 для всех. */
export function transientCooldownMs(kind: ApiFailureKind | undefined): number {
  const base = breakerCooldownMs();
  return kind === "region" && base > 0 ? Math.max(base, REGION_COOLDOWN_MS) : base;
}

/**
 * ДОСРОЧНОЕ снятие паузы гео-блока (адверс-ревью р2): VPN обычно поднимается через секунды после входа в Windows,
 * а 30 минут быстрый канал пропускался и паспорт твердил «временно не отвечает». Доказательство «сеть починилась» —
 * подписка (та же машина, та же сеть) сначала ТОЖЕ не смогла, а потом ответила. Одного успеха мало: в ходе, где
 * пауза встала, подписка отвечает ПОСЛЕ отказа API (снятие там обнулило бы паузу), а если CLI ходит другим маршрутом,
 * снятие по любому успеху давало бы 2 мёртвых вызова API каждые 3 хода. Паузу по иной причине (сеть/429/перегруз
 * самого API) успех подписки не снимает — это не про маршрут.
 */
export class RegionPauseHeal {
  private state: "none" | "armed" | "proven" = "none";

  /** Встала пауза: следим за ней, только если её причина — гео-блок. */
  paused(kind: ApiFailureKind | undefined): void {
    this.state = kind === "region" ? "armed" : "none";
  }

  /** Подписка не смогла при паузе гео-блока — сеть недоступна и ей: следующий её успех докажет починку. */
  subscriptionFailed(): void {
    if (this.state === "armed") this.state = "proven";
  }

  /** Подписка ответила при действующей паузе. true — гео-блок доказанно снят, паузу основного пора снимать. */
  subscriptionOk(): boolean {
    if (this.state !== "proven") return false;
    this.state = "none";
    log.info("подписка снова отвечает после гео-блока — сеть починилась, пауза основного канала снята досрочно");
    return true;
  }
}
