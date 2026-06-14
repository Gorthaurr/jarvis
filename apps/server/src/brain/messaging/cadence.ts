/**
 * Cadence guard — защита от банов и спам-сигнатуры (§12, §14).
 *
 * Правила человеческого конверта (§3 принцип 3, §14):
 *  - rate-limit на получателя (не больше N сообщений в окно);
 *  - запрет веера (нельзя писать многим получателям пачкой);
 *  - запрет burst-серий (минимальный человеческий интервал между отправками);
 *  - запрет писать контакту, которому никогда не писали, без явного подтверждения;
 *  - человеческий джиттер задержки перед отправкой.
 *
 * Чистая логика поверх in-memory истории; время инъектируется (тестируемость).
 */
import { humanJitter } from "@jarvis/shared";

export interface CadenceConfig {
  /** Окно учёта (мс). */
  windowMs: number;
  /** Макс. сообщений одному получателю за окно. */
  maxPerRecipient: number;
  /** Макс. РАЗНЫХ получателей за окно (анти-веер). */
  maxDistinctRecipients: number;
  /** Минимальный интервал между любыми отправками (анти-burst). */
  minGapMs: number;
  /** Базовая человеческая задержка перед отправкой (джиттерится). */
  baseDelayMs: number;
}

export const DEFAULT_CADENCE: CadenceConfig = {
  windowMs: 60_000,
  maxPerRecipient: 3,
  maxDistinctRecipients: 4,
  minGapMs: 3_000,
  baseDelayMs: 1_500,
};

export interface CadenceCheckInput {
  userId: string;
  channel: string;
  recipient: string;
  /** Писал ли пользователь когда-либо этому контакту (§14). */
  neverMessagedBefore: boolean;
}

export interface CadenceDecision {
  allowed: boolean;
  reason?: "rate_limit" | "fan_out" | "burst";
  /** Требуется явное подтверждение (новый контакт, §14). */
  requiresConfirm: boolean;
  /** Рекомендованная задержка перед отправкой (человеческий темп). */
  suggestedDelayMs: number;
}

interface Attempt {
  userId: string;
  recipient: string;
  ts: number;
}

export class CadenceGuard {
  private readonly history: Attempt[] = [];
  constructor(
    private readonly cfg: CadenceConfig = DEFAULT_CADENCE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(input: CadenceCheckInput): CadenceDecision {
    const t = this.now();
    const recent = this.history.filter((a) => a.userId === input.userId && t - a.ts <= this.cfg.windowMs);

    const toRecipient = recent.filter((a) => a.recipient === input.recipient);
    if (toRecipient.length >= this.cfg.maxPerRecipient) {
      return this.deny("rate_limit", input.neverMessagedBefore);
    }

    const distinct = new Set(recent.map((a) => a.recipient));
    const isNewRecipientThisWindow = !distinct.has(input.recipient);
    if (isNewRecipientThisWindow && distinct.size >= this.cfg.maxDistinctRecipients) {
      return this.deny("fan_out", input.neverMessagedBefore);
    }

    if (recent.length > 0) {
      const lastTs = recent.reduce((mx, a) => Math.max(mx, a.ts), recent[0]!.ts);
      if (t - lastTs < this.cfg.minGapMs) {
        return this.deny("burst", input.neverMessagedBefore);
      }
    }

    return {
      allowed: true,
      requiresConfirm: input.neverMessagedBefore, // новый контакт → confirm (§14)
      suggestedDelayMs: humanJitter(this.cfg.baseDelayMs),
    };
  }

  /** Зафиксировать факт отправки (после успешной доставки). */
  record(userId: string, recipient: string): void {
    this.history.push({ userId, recipient, ts: this.now() });
  }

  private deny(reason: CadenceDecision["reason"], neverMessaged: boolean): CadenceDecision {
    return { allowed: false, reason, requiresConfirm: neverMessaged, suggestedDelayMs: 0 };
  }
}
