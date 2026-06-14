/**
 * Тёплость сессии (§15): кешировать prompt-префикс осмысленно только внутри
 * активной сессии (диалог/агентская задача). Вне сессии (редкая разовая команда)
 * запись кеша стоит 1.25× и пропадает впустую — для такого случая шлём тощий
 * префикс БЕЗ cache_control.
 *
 * Сессия «тёплая», если LLM-вызов в ней был не дольше windowMs назад (= TTL кеша).
 */
export class SessionWarmth {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Тёплая ли сессия — стоит ли кешировать префикс (§15). */
  isWarm(sessionId: string): boolean {
    const t = this.last.get(sessionId);
    return t !== undefined && this.now() - t < this.windowMs;
  }

  /** Отметить LLM-активность в сессии (после каждого вызова). */
  touch(sessionId: string): void {
    this.last.set(sessionId, this.now());
  }

  /** Забыть сессию (закрытие соединения) — чтобы Map не рос бесконечно. */
  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}
