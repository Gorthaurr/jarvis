/**
 * Скользящее окно в памяти для лимитов входа (план §5.1: OTP 5/ч на email, 20/ч на IP, login 30/ч на IP).
 * Зависимости на @fastify/rate-limit в проекте нет — свой минимальный класс. Часы инжектируются: тесты
 * двигают время, а не ждут. На ключ хранятся моменты попаданий внутри окна; когда таблица разрастается
 * до maxKeys, ключи с протухшими попаданиями выметаются — иначе перебор адресов раздувал бы процесс.
 *
 * ЧЕСТНОСТЬ ГРАНИЦ: это защита ОДНОГО процесса. Рестарт обнуляет счётчики, несколько инстансов друг о
 * друге не знают — для облачной роли с репликами понадобится общий стор. Записано здесь, а не спрятано.
 */
export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
}

export type RateLimitVerdict = { ok: true; remaining: number } | { ok: false; retryAfterMs: number };

interface Bucket {
  hits: number[]; // моменты попаданий по возрастанию
  windowMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Занять слот. ok:false — лимит исчерпан; retryAfterMs — через сколько освободится самый старый слот. */
  take(key: string, rule: RateLimitRule): RateLimitVerdict {
    if (!(rule.max > 0) || !(rule.windowMs > 0)) {
      throw new Error(`RateLimiter: некорректное правило max=${rule.max} windowMs=${rule.windowMs}`);
    }
    const now = this.clock();
    let b = this.buckets.get(key);
    if (b) {
      b.windowMs = rule.windowMs;
      prune(b, now);
      if (b.hits.length >= rule.max) {
        return { ok: false, retryAfterMs: Math.max(1, (b.hits[0] ?? now) + rule.windowMs - now) };
      }
    } else {
      this.sweepIfCrowded(now);
      b = { hits: [], windowMs: rule.windowMs };
      this.buckets.set(key, b);
    }
    b.hits.push(now);
    return { ok: true, remaining: rule.max - b.hits.length };
  }

  reset(): void {
    this.buckets.clear();
  }

  /** Сколько ключей удерживается (диагностика/тест выметания). */
  size(): number {
    return this.buckets.size;
  }

  private sweepIfCrowded(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    for (const [key, b] of this.buckets) {
      prune(b, now);
      if (b.hits.length === 0) this.buckets.delete(key);
    }
  }
}

/** Выбросить попадания, вышедшие из окна (граница включительно: попадание ровно windowMs назад уже свободно). */
function prune(b: Bucket, now: number): void {
  const since = now - b.windowMs;
  let i = 0;
  while (i < b.hits.length && (b.hits[i] ?? 0) <= since) i++;
  if (i > 0) b.hits.splice(0, i);
}
