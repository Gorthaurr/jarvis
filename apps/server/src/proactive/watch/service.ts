/**
 * Сервис НАБЛЮДЕНИЙ (watch): durable-store + recurring-таймер next-due + проверка условия (инъектируемый
 * checker) + проактивная доставка результата той же речью, что напоминания.
 *
 * Поток: add() ставит наблюдение → таймер будит на ближайший due → tick() прогоняет checker для созревших
 * → met → озвучить summary (или отложить до подключения) → continuous: следить дальше (антидребезг по
 * summary); one-shot: пометить fired. Checker — общий (LLM водит web/market), сервис в ЧТО смотрим не лезет.
 *
 * Зеркалит ReminderService (тот же реестр озвучек по userId §6B/B3, тот же next-wakeup, тот же durable-стор).
 */
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { WatchStore } from "./store.js";
import { type CheckResult, type Watch, type WatchChecker, dueAt } from "./watch.js";

const log: Logger = createLogger("watch");

/** Потолок setTimeout (~24.8 дня): на больших интервалах спим максимум столько и пере-планируемся. */
const MAX_DELAY = 2 ** 31 - 1;

export interface WatchServiceOpts {
  now?: () => number;
  /** Минимальный период проверки — анти-DDoS источников и анти-runaway (деф 30с, env JARVIS_WATCH_MIN_INTERVAL_MS). */
  minIntervalMs?: number;
  /** Максимум активных наблюдений на пользователя (анти-runaway, деф 20). */
  maxPerUser?: number;
}

export class WatchService {
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false; // защита от перекрытия тиков (checker асинхронный, может быть долгим)
  private readonly speakers = new Map<string, { userId: string; speak: (text: string) => void }>();
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxPerUser: number;

  constructor(
    private readonly checker: WatchChecker,
    private readonly store: WatchStore = new WatchStore(),
    opts: WatchServiceOpts = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minIntervalMs ?? envInt("JARVIS_WATCH_MIN_INTERVAL_MS", 30_000);
    this.maxPerUser = opts.maxPerUser ?? envInt("JARVIS_WATCH_MAX_PER_USER", 20);
  }

  /** Старт: загрузить стор, завести таймер на ближайшую проверку. */
  async start(): Promise<void> {
    await this.store.load();
    this.reschedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Итог постановки наблюдения: ok + запись, либо отказ с причиной (лимит). */
  add(input: {
    sessionId: string;
    userId: string;
    what: string;
    condition: string;
    intervalMs: number;
    continuous?: boolean;
  }): { ok: true; watch: Watch } | { ok: false; reason: "limit" | "invalid" } {
    const what = input.what.trim();
    const condition = input.condition.trim();
    if (!what || !condition) return { ok: false, reason: "invalid" };
    if (this.store.list({ userId: input.userId }).length >= this.maxPerUser) {
      log.warn("лимит активных наблюдений на пользователя — отказ", { userId: input.userId, max: this.maxPerUser });
      return { ok: false, reason: "limit" };
    }
    const w: Watch = {
      id: newId(),
      sessionId: input.sessionId,
      userId: input.userId,
      what,
      condition,
      intervalMs: Math.max(this.minIntervalMs, Math.floor(input.intervalMs)),
      continuous: input.continuous ?? false,
      status: "active",
      createdAt: this.now(),
    };
    this.store.add(w);
    this.reschedule();
    log.info("наблюдение поставлено", { id: w.id, intervalMs: w.intervalMs, continuous: w.continuous, what: w.what.slice(0, 60) });
    return { ok: true, watch: w };
  }

  /** Снять наблюдение по id или по совпадению в `what` (последнее). Возвращает снятую запись или null. */
  cancel(idOrQuery: string, userId?: string): Watch | null {
    const byId = this.store.get(idOrQuery);
    let target = byId && byId.status === "active" ? byId : undefined;
    if (!target) {
      const q = idOrQuery.toLowerCase().trim();
      const matches = this.store.list(userId ? { userId } : undefined).filter((w) => w.what.toLowerCase().includes(q));
      target = matches[matches.length - 1];
    }
    if (!target) return null;
    this.store.cancel(target.id);
    this.reschedule();
    log.info("наблюдение снято", { id: target.id });
    return target;
  }

  list(filter?: { sessionId?: string; userId?: string }): Watch[] {
    return this.store.list(filter);
  }

  /** Зарегистрировать канал озвучки сессии (с владельцем) и сразу отдать отложенные уведомления ЭТОГО юзера. */
  registerSpeaker(sessionId: string, userId: string, speak: (text: string) => void): void {
    this.speakers.set(sessionId, { userId, speak });
    this.flushPending(userId);
  }

  unregisterSpeaker(sessionId: string): void {
    this.speakers.delete(sessionId);
  }

  // ── внутреннее ──────────────────────────────────────────────

  /** Канал озвучки: точная сессия → ЛЮБАЯ сессия ТОГО ЖЕ userId (reconnect/мульти-девайс) → undefined.
   *  НИКОГДА не доставляем в сессию ДРУГОГО пользователя (как у напоминаний, §6B/B3). */
  private speakerFor(w: Watch): ((text: string) => void) | undefined {
    const exact = this.speakers.get(w.sessionId);
    if (exact) return exact.speak;
    for (const s of this.speakers.values()) if (s.userId === w.userId) return s.speak;
    return undefined;
  }

  /** Доставить уведомление (озвучить) — или пометить pendingNotify, если активной озвучки нет. */
  private notify(w: Watch, summary: string): void {
    const speak = this.speakerFor(w);
    if (speak) {
      speak(summary);
      w.lastNotifiedSummary = summary;
      w.pendingNotify = undefined;
      log.info("наблюдение: уведомление озвучено", { id: w.id });
    } else {
      w.pendingNotify = summary;
      log.info("наблюдение сработало, но нет активной сессии — отложено до подключения", { id: w.id });
    }
  }

  /** Отложенные уведомления ЭТОГО userId (включая сработавшие one-shot fired) — проговорить через только
   *  что подключившуюся сессию (приложение было закрыто в момент срабатывания). */
  private flushPending(userId: string): void {
    for (const w of this.store.withPendingNotify(userId)) {
      const speak = this.speakerFor(w);
      if (!speak || !w.pendingNotify) continue;
      speak(w.pendingNotify);
      w.lastNotifiedSummary = w.pendingNotify;
      w.pendingNotify = undefined;
      this.store.update(w);
      log.info("наблюдение: отложенное уведомление доставлено при подключении", { id: w.id });
    }
  }

  /** Прогнать все созревшие проверки и пере-планироваться. Зовётся таймером; публичен для тестов/ручного
   *  триггера. Re-entrancy-гард: перекрывающийся вызов (долгий checker) — no-op. */
  async tickNow(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.store.active().filter((w) => dueAt(w, now) <= now);
      for (const w of due) await this.runCheck(w);
      this.store.prune(this.now());
    } catch (e) {
      log.warn("ошибка тика наблюдений", e instanceof Error ? e.message : String(e));
    } finally {
      this.ticking = false;
      this.reschedule();
    }
  }

  /** Прогнать одну проверку: отметить lastCheckAt (анти-повтор-due), вызвать checker, обработать исход. */
  private async runCheck(w: Watch): Promise<void> {
    w.lastCheckAt = this.now(); // ставим ДО await — иначе наблюдение снова «созреет» во время долгой проверки
    let res: CheckResult;
    try {
      res = await this.checker(w);
    } catch (e) {
      res = { met: false, summary: "", error: e instanceof Error ? e.message : String(e) };
    }
    if (res.value !== undefined) w.lastValue = res.value;
    if (res.error) {
      log.info("наблюдение: проверка не удалась (повторю в следующий тик)", { id: w.id, error: res.error.slice(0, 120) });
      this.store.update(w);
      return;
    }
    if (res.met) {
      const summary = res.summary.trim() || `Сработало наблюдение: ${w.what}.`;
      // continuous: не дублируем идентичное уведомление подряд (антидребезг); состояние «отлипло» — снова уведомим.
      if (!(w.continuous && w.lastNotifiedSummary === summary)) {
        w.firedAt = this.now();
        this.notify(w, summary);
        if (!w.continuous) w.status = "fired"; // one-shot завершилось
      }
    } else if (w.continuous) {
      // состояние перестало удовлетворять условию → сбрасываем антидребезг (следующее met снова прозвучит).
      w.lastNotifiedSummary = undefined;
    }
    this.store.update(w);
  }

  /** Один таймер на ближайшую созревающую проверку (next-wakeup), большие интервалы — кусками по MAX_DELAY. */
  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const active = this.store.active();
    if (active.length === 0) return;
    const now = this.now();
    const next = active.reduce((min, w) => Math.min(min, dueAt(w, now)), Number.POSITIVE_INFINITY);
    const delay = Math.min(MAX_DELAY, Math.max(0, next - now));
    this.timer = setTimeout(() => void this.tickNow(), delay);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
  }
}

function envInt(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
