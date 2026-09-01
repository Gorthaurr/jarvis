/**
 * ЧАСОВОЙ ПРЕДОХРАНИТЕЛЬ автономных LLM-вызовов (волна E, урок Skales «пауза после N задач»):
 * единый скользящий лимит на ВСЕ фоновые вызовы БЕЗ реплики владельца — watch-checker,
 * авто-предиктор (эксперт), сон-цикл консолидации, рефлексы памяти/обязательств. У каждого есть
 * свои суточные капы и месячный SpendGuard, но ОБЩЕГО часового не было: шторм наблюдений мог
 * молотить в пределах месячного потолка. Это предохранитель от ШТОРМА, не бюджет: дефолт щедрый
 * (120/час ≈ один непрерывный LLM-watch), env `JARVIS_AUTONOMOUS_LLM_PER_HOUR` (0 = выключен).
 *
 * Превышение → честный WARN (раз в окно) + durable-деградация (onBlocked) + отказ. Вызывающий
 * ОБЯЗАН обработать отказ честно: watch-чекер — транзиентный «не смог проверить» (НЕ met:false),
 * рефлексы/консолидация — тихий пропуск (бэкстопу пропустить тише, чем молотить). Ходы ВЛАДЕЛЬЦА
 * этим не гейтятся НИКОГДА.
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("autonomy");

const WINDOW_MS = 3600_000;

function envLimit(): number {
  const raw = process.env.JARVIS_AUTONOMOUS_LLM_PER_HOUR;
  if (raw === undefined || raw === "") return 120;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 120;
  return n; // 0 = выключен (без лимита)
}

export class AutonomyThrottle {
  private stamps: number[] = [];
  private warnedAt = -Infinity;
  private onBlocked?: (kind: string) => void;

  constructor(
    private readonly limit: number | undefined = undefined, // undefined → env при КАЖДОМ вызове (лениво)
    private readonly now: () => number = Date.now,
  ) {}

  /** Куда докладывать о срабатывании (durable-деградация metrics) — ставится на boot. */
  setOnBlocked(cb: (kind: string) => void): void {
    this.onBlocked = cb;
  }

  /** true — вызов разрешён (и учтён). false — лимит исчерпан, вызывающий обязан честно пропустить. */
  tryAcquire(kind: string): boolean {
    const limit = this.limit ?? envLimit();
    if (limit === 0) return true; // выключен
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < WINDOW_MS);
    if (this.stamps.length >= limit) {
      if (t - this.warnedAt >= WINDOW_MS) {
        this.warnedAt = t;
        log.warn("часовой предохранитель автономных LLM-вызовов сработал — фоновые вызовы приостановлены", {
          kind,
          limit,
          заВремяОкна: this.stamps.length,
        });
      }
      try {
        this.onBlocked?.(kind);
      } catch {
        /* деградация — best-effort */
      }
      return false;
    }
    this.stamps.push(t);
    return true;
  }
}

let singleton: AutonomyThrottle | undefined;
export function autonomyThrottle(): AutonomyThrottle {
  if (!singleton) singleton = new AutonomyThrottle();
  return singleton;
}
export function setAutonomyThrottleForTests(t: AutonomyThrottle | undefined): void {
  singleton = t;
}
