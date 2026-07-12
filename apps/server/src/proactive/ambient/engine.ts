/**
 * ДВИЖОК ambient-осведомлённости: периодически и ДЁШЕВО опрашивает источники, дедуплицирует новые сигналы,
 * фильтрует по САЛИЕНТНОСТИ и проактивно проговаривает важное (тот же speaker-registry, что напоминания/watch,
 * §6B/B3 изоляция по userId; уважает «не мешать» §9 через speakQueued). LLM-фразировщик зовётся ТОЛЬКО на
 * НОВЫЙ салиентный сигнал — токен-эконом как качество (тики сами по себе бесплатны).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { AmbientSeenStore } from "./store.js";
import type { AmbientPhraser, AmbientSignal, AmbientSource } from "./signal.js";

const log: Logger = createLogger("ambient");

export interface AmbientEngineOpts {
  now?: () => number;
  /** Период опроса источников (мс). Деф 90с (env JARVIS_AMBIENT_INTERVAL_MS). Дёшево → можно часто. */
  intervalMs?: number;
  /** Порог салиентности [0..1]: ниже — не тревожим владельца. Деф 0.5 (env JARVIS_AMBIENT_MIN_SALIENCE). */
  minSalience?: number;
  /** LLM-фразировщик (опц.): сырой сигнал → дворецкая фраза. Зовётся лишь на НОВОЕ важное. null → title как есть. */
  phraser?: AmbientPhraser;
}

export class AmbientEngine {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly speakers = new Map<string, { userId: string; speak: (text: string, urgent: boolean) => void }>();
  /** Недоставленное (сессии не было в момент сигнала) → проговорить при подключении владельца. */
  private pending: Array<{ userId: string; text: string; urgent: boolean; seenKey: string }> = [];
  /** Аудит-2 [6]: сигналы, поставленные в pending В ЭТОМ ПРОЦЕССЕ (анти-дубль на тиках), НЕ persist —
   *  durable «seen» ставится ЛИШЬ при реальной доставке, иначе рестарт до flush терял бы срочный сигнал. */
  private readonly queuedKeys = new Set<string>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly minSalience: number;
  private readonly phraser?: AmbientPhraser;

  constructor(
    private readonly sources: AmbientSource[],
    private readonly store: AmbientSeenStore = new AmbientSeenStore(),
    opts: AmbientEngineOpts = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? envInt("JARVIS_AMBIENT_INTERVAL_MS", 90_000);
    this.minSalience = opts.minSalience ?? envFloat("JARVIS_AMBIENT_MIN_SALIENCE", 0.5);
    this.phraser = opts.phraser;
  }

  async start(): Promise<void> {
    await this.store.load();
    void this.tickNow(); // первый опрос вскоре после старта
    this.timer = setInterval(() => void this.tickNow(), this.intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
    log.info("ambient-движок запущен", { sources: this.sources.map((s) => s.id), intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** M13: дождаться отложенных записей seen-стора (graceful shutdown) — иначе уже-показанное ambient
   *  пере-сработает после рестарта (пометка «seen» не успела лечь на диск). */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  /** Зарегистрировать канал озвучки сессии (с владельцем) и сразу отдать отложенные ЭТОГО юзера. */
  registerSpeaker(sessionId: string, userId: string, speak: (text: string, urgent: boolean) => void): void {
    this.speakers.set(sessionId, { userId, speak });
    this.flushPending(userId);
  }

  unregisterSpeaker(sessionId: string): void {
    this.speakers.delete(sessionId);
  }

  /** Текущее состояние источников (для статуса/диагностики). */
  status(): Array<{ id: string; label: string; enabled: boolean }> {
    return this.sources.map((s) => ({ id: s.id, label: s.label, enabled: s.enabled() }));
  }

  /** Один проход опроса всех источников. Публичен для тестов/ручного триггера. Re-entrancy-гард. */
  async tickNow(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const src of this.sources) {
        if (!src.enabled()) continue;
        let signals: AmbientSignal[];
        try {
          signals = await src.poll();
        } catch (e) {
          log.info("ambient: источник не отдал сигналы (пропуск)", { source: src.id, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        for (const sig of signals) await this.consider(sig);
      }
      this.store.prune(this.now());
    } finally {
      this.ticking = false;
    }
  }

  // ── внутреннее ──────────────────────────────────────────────

  /** Рассмотреть один сигнал: новый (не seen) + салиентный → сформулировать и проактивно сообщить. */
  private async consider(sig: AmbientSignal): Promise<void> {
    const seenKey = `${sig.sourceId}:${sig.key}`;
    if (this.store.has(seenKey) || this.queuedKeys.has(seenKey)) return; // доставлено durable ИЛИ уже в очереди процесса
    if (sig.salience < this.minSalience) {
      this.store.mark(seenKey, this.now()); // не важно — durable-помечаем, чтобы не пересматривать каждый тик
      return;
    }
    // ЛИШЬ ТЕПЕРЬ (новое важное) — опц. LLM-фразировка. Дорого ровно на событиях, не на тиках.
    let phrase = sig.title;
    if (this.phraser) {
      try {
        const p = await this.phraser(sig);
        if (p && p.trim()) phrase = p.trim();
      } catch (e) {
        log.debug("ambient: фразировщик не сработал — беру title", e instanceof Error ? e.message : String(e));
      }
    }
    // Аудит-2 [6]: durable-mark ТОЛЬКО при РЕАЛЬНОЙ доставке живой сессии. Владелец офлайн → сигнал в
    // in-memory pending, durable НЕ помечаем (queuedKeys гасит дубль в рамках процесса). Рестарт до flush
    // потеряет pending, но seenKey на диске НЕ осядет → сигнал пересмотрится и прозвучит (раньше срочный
    // «оплати счёт» глох навсегда на 14 дней TTL).
    const speak = this.speakerFor(sig.userId);
    if (speak) {
      this.store.mark(seenKey, this.now());
      speak(phrase, sig.urgent === true);
      log.info("ambient: проактивное уведомление", { source: sig.sourceId, key: sig.key.slice(0, 40), urgent: sig.urgent === true });
    } else {
      this.queuedKeys.add(seenKey);
      this.pending.push({ userId: sig.userId, text: phrase, urgent: sig.urgent === true, seenKey });
      log.info("ambient: уведомление отложено (владелец офлайн)", { source: sig.sourceId, key: sig.key.slice(0, 40), urgent: sig.urgent === true });
    }
  }

  private speakerFor(userId: string): ((text: string, urgent: boolean) => void) | undefined {
    for (const s of this.speakers.values()) if (s.userId === userId) return s.speak;
    return undefined;
  }

  private flushPending(userId: string): void {
    if (this.pending.length === 0) return;
    const speak = this.speakerFor(userId);
    if (!speak) return;
    const mine = this.pending.filter((p) => p.userId === userId);
    this.pending = this.pending.filter((p) => p.userId !== userId);
    for (const p of mine) {
      this.store.mark(p.seenKey, this.now()); // Аудит-2 [6]: доставлено из очереди → ТЕПЕРЬ durable seen
      this.queuedKeys.delete(p.seenKey);
      speak(p.text, p.urgent);
    }
  }
}

function envInt(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function envFloat(name: string, def: number): number {
  const n = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : def;
}
