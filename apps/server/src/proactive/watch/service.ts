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
  /** Dead-watch (D3): провалов проверки подряд → suspended (деф 10, env JARVIS_WATCH_MAX_FAILURES). */
  maxFailures?: number;
}

/** §Волна3 (3.4): канал клиентской проверки предиката — sendAction живой сессии (wait.for-словарь). */
export type PredicateSender = (cmd: Record<string, unknown>, timeoutMs: number) => Promise<{
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}>;

/** fix 2026-07-15: исход серверной проверки BROWSER-предиката (чтение DOM-значения вкладки через ext). */
export interface BrowserProbeResult {
  met: boolean;
  detail: string;
  /** Ошибка проверки (расширение отключено / нет вкладки). transient=true → НЕ инкрементит dead-watch. */
  error?: string;
  transient?: boolean;
}

export class WatchService {
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false; // защита от перекрытия тиков (checker асинхронный, может быть долгим)
  private readonly speakers = new Map<string, { userId: string; speak: (text: string) => void }>();
  /** §Волна3 (3.4): каналы sendAction живых сессий — для предикат-наблюдений (проверка на клиенте). */
  private readonly actions = new Map<string, { userId: string; send: PredicateSender }>();
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly minPredicateIntervalMs: number;
  private readonly maxPerUser: number;
  private readonly maxFailures: number;

  constructor(
    private readonly checker: WatchChecker,
    private readonly store: WatchStore = new WatchStore(),
    opts: WatchServiceOpts = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minIntervalMs ?? envInt("JARVIS_WATCH_MIN_INTERVAL_MS", 30_000);
    // Предикат-проверка — локальная и копеечная (клиентский поллинг, $0) → интервал жмётся сильнее
    // LLM-чекера («когда матч найдётся» нужен каждые ~5с, не 30с).
    this.minPredicateIntervalMs = envInt("JARVIS_WATCH_MIN_PREDICATE_INTERVAL_MS", 5_000);
    this.maxPerUser = opts.maxPerUser ?? envInt("JARVIS_WATCH_MAX_PER_USER", 20);
    // Dead-watch (D3): столько провалов проверки подряд → suspended + одно уведомление владельцу.
    this.maxFailures = opts.maxFailures ?? envInt("JARVIS_WATCH_MAX_FAILURES", 10);
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

  /** M13: дождаться отложенных записей стора (graceful shutdown) — чтобы снятое/сработавшее наблюдение
   *  не потерялось на рестарте внутри debounce-окна записи. */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  /** Итог постановки наблюдения: ok + запись, либо отказ с причиной (лимит). */
  add(input: {
    sessionId: string;
    userId: string;
    what: string;
    condition: string;
    intervalMs: number;
    continuous?: boolean;
    /** §Волна3 (3.4): локальный предикат (WaitCondition) — проверка на клиенте вместо LLM-чекера. */
    predicate?: unknown;
  }): { ok: true; watch: Watch } | { ok: false; reason: "limit" | "invalid" } {
    const what = input.what.trim();
    const condition = input.condition.trim();
    if (!what || !condition) return { ok: false, reason: "invalid" };
    if (this.store.list({ userId: input.userId }).length >= this.maxPerUser) {
      log.warn("лимит активных наблюдений на пользователя — отказ", { userId: input.userId, max: this.maxPerUser });
      return { ok: false, reason: "limit" };
    }
    const minInterval = input.predicate ? this.minPredicateIntervalMs : this.minIntervalMs;
    const w: Watch = {
      id: newId(),
      sessionId: input.sessionId,
      userId: input.userId,
      what,
      condition,
      intervalMs: Math.max(minInterval, Math.floor(input.intervalMs)),
      continuous: input.continuous ?? false,
      status: "active",
      createdAt: this.now(),
      ...(input.predicate ? { predicate: input.predicate } : {}),
    };
    this.store.add(w);
    this.reschedule();
    log.info("наблюдение поставлено", { id: w.id, intervalMs: w.intervalMs, continuous: w.continuous, what: w.what.slice(0, 60) });
    return { ok: true, watch: w };
  }

  /** Снять наблюдение по id или по совпадению в `what` (последнее). Возвращает снятую запись или null. */
  cancel(idOrQuery: string, userId?: string): Watch | null {
    const byId = this.store.get(idOrQuery);
    // §sec (M12): by-id fast-path ТОЖЕ уважает userId-фильтр (как text-fallback ниже) — иначе, зная
    // эхнутый id, можно снять ЧУЖОЕ наблюдение. С userId — id обязан принадлежать этому пользователю.
    let target = byId && byId.status === "active" && (!userId || byId.userId === userId) ? byId : undefined;
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

  /** §Волна3 (3.4): канал sendAction сессии — предикат-наблюдения проверяются на ЕЁ клиенте. */
  registerActions(sessionId: string, userId: string, send: PredicateSender): void {
    this.actions.set(sessionId, { userId, send });
  }

  /**
   * fix 2026-07-15: серверная проверка BROWSER-предиката (video.currentTime и т.п. через ext-мост
   * расширения — оно на сервере, не на клиенте). Инжектится из server.ts. Нет probe / расширение
   * отключено → browser-предикат сообщает транзиентную недоступность (НЕ dead-watch — вкладка вернётся).
   */
  private browserProbe?: (predicate: unknown) => Promise<BrowserProbeResult>;
  setBrowserProbe(fn: (predicate: unknown) => Promise<BrowserProbeResult>): void {
    this.browserProbe = fn;
  }

  unregisterActions(sessionId: string): void {
    this.actions.delete(sessionId);
  }

  /** Канал действий: точная сессия → любая сессия ТОГО ЖЕ userId (правило §6B/B3, как speakerFor). */
  private actionFor(w: Watch): PredicateSender | undefined {
    const exact = this.actions.get(w.sessionId);
    if (exact && exact.userId === w.userId) return exact.send;
    for (const a of this.actions.values()) if (a.userId === w.userId) return a.send;
    return undefined;
  }

  /**
   * §Волна3 (3.4): проверка ЛОКАЛЬНОГО предиката — один короткий wait.for на клиенте владельца
   * ($0, миллисекунды; таймаут чуть больше пары поллов). Нет живого клиента → честная ошибка
   * (повторим в следующий тик), НЕ met (недоступность сенсора ≠ «условие выполнено»).
   */
  private async checkPredicate(w: Watch): Promise<CheckResult> {
    // fix 2026-07-15: BROWSER-предикат (video.currentTime и т.п.) проверяем СЕРВЕРНО через ext-мост —
    // расширение подключено к серверу, а клиентский wait.for до него не достаёт (раньше агент подсовывал
    // OCR таймера {kind:"text"} — тот на этой машине висел >25с и наблюдение падало каждый тик).
    const pred = w.predicate as { kind?: unknown } | undefined;
    if (pred?.kind === "browser") {
      if (!this.browserProbe) {
        return { met: false, summary: "", error: "браузерная проверка недоступна (расширение не подключено)", transient: true };
      }
      const r = await this.browserProbe(w.predicate);
      if (r.error) return { met: false, summary: "", error: r.error, transient: r.transient };
      return { met: r.met, value: r.detail ? r.detail.slice(0, 200) : undefined, summary: r.met ? `Сработало: ${w.condition}.` : "" };
    }
    const send = this.actionFor(w);
    // Ревью р2 #6: НЕТ живой сессии — ТРАНЗИЕНТНАЯ инфраструктура (клиент закрыт/resume-grace/сетевой
    // блип), НЕ провал проверки. transient=true → runCheck НЕ инкрементит dead-watch (иначе «скажи когда
    // матч найдётся» + свёрнутое на минуту окно = 10 тиков × 5с → навсегда suspended до возврата владельца).
    if (!send) return { met: false, summary: "", error: "нет живой сессии клиента для проверки предиката", transient: true };
    try {
      // D2 (форензика 2026-07-14): серверный ActionCommand-таймаут ДОЛЖЕН быть ВЫШЕ клиентского бюджета
      // сенсора (OCR-путь sensors-cheap до 20с), иначе КАЖДЫЙ полл = «нет result за 8000ms». Даём 25с.
      const res = await send({ kind: "wait.for", condition: w.predicate, timeoutMs: 1_500, pollMs: 700 }, 25_000);
      if (!res.ok) return { met: false, summary: "", error: res.error?.message ?? res.error?.code ?? "wait.for failed" };
      const data = res.data as { met?: boolean; detail?: string; gsiState?: "fresh" | "stale" | "none" } | undefined;
      let met = data?.met === true;
      // Ревью фиксов, 2-й проход (R4) — STATEFUL-детект исчезновения gsi+gone. Клиентское окно
      // recentlyGone (~135с) короче произвольного интервала наблюдения: тик реже окна (или даунтайм
      // сервера поверх события) навсегда пропускал бы исчезновение — one-shot висел бы active в
      // тишине. Наблюдение само помнит, что видело источник ЖИВЫМ (sawFreshAt, durable), и любое
      // последующее «запись есть, но протухла» (stale) = исчезновение. «none» (клиент перезапущен,
      // стор пуст) намеренно НЕ засчитываем — живая игра снова запушит в ≤30с (heartbeat), а met по
      // пустому стору был бы ложным «закончилось» посреди матча.
      const pred = w.predicate as { kind?: unknown; gone?: unknown } | undefined;
      if (pred?.kind === "gsi" && pred.gone === true && data?.gsiState) {
        if (data.gsiState === "fresh") w.sawFreshAt = this.now(); // персистится store.update в runCheck
        else if (!met && data.gsiState === "stale" && w.sawFreshAt !== undefined) met = true;
      }
      return {
        met,
        value: typeof data?.detail === "string" ? data.detail.slice(0, 200) : undefined,
        // Фраза владельцу — из condition (модель формулирует условие человеческим языком).
        summary: met ? `Сработало: ${w.condition}.` : "",
      };
    } catch (e) {
      return { met: false, summary: "", error: e instanceof Error ? e.message : String(e) };
    }
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
      // §Волна3 ревью (#14): проверки НЕЗАВИСИМЫ (каждая мутирует свою запись) → гоним ПАРАЛЛЕЛЬНО, а не
      // последовательно. Раньше один невыполненный предикат держал клиентский wait.for до 1.5с (мёртвый
      // клиент — до 8с), и N наблюдений сериализовались, ломая каденцию 5-10с и задерживая созревшие
      // LLM-watch'и того же тика. runCheck ловит свои ошибки внутри — Promise.all не оборвётся.
      await Promise.all(due.map((w) => this.runCheck(w)));
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
      // §Волна3 (3.4): предикат-наблюдение проверяется НА КЛИЕНТЕ ($0), обычное — LLM-чекером.
      res = w.predicate ? await this.checkPredicate(w) : await this.checker(w);
    } catch (e) {
      res = { met: false, summary: "", error: e instanceof Error ? e.message : String(e) };
    }
    if (res.value !== undefined) w.lastValue = res.value;
    if (res.error) {
      // Ревью р2 #6: транзиентная ошибка (нет живой сессии) — НЕ dead-watch (клиент вернётся). Логируем,
      // счётчик НЕ трогаем, пробуем в следующий тик.
      if (res.transient) {
        log.info("наблюдение: проверка отложена (нет живой сессии — транзиентно)", { id: w.id });
        this.store.update(w);
        return;
      }
      // Dead-watch (D3, форензика 2026-07-14: 142 провала подряд горели в тишине, чекер вне SpendGuard).
      w.consecutiveFailures = (w.consecutiveFailures ?? 0) + 1;
      log.info("наблюдение: проверка не удалась (повторю в следующий тик)", {
        id: w.id,
        error: res.error.slice(0, 120),
        fails: w.consecutiveFailures,
      });
      if (w.consecutiveFailures >= this.maxFailures) {
        w.status = "suspended";
        w.firedAt = this.now(); // ревью р2 #8: prune держит запись 24ч от firedAt (иначе pendingNotify стёрся бы до доставки)
        log.warn("наблюдение ПРИОСТАНОВЛЕНО: серия провалов проверки — больше не тикает", { id: w.id, fails: w.consecutiveFailures });
        this.notify(w, `Не смог наблюдать «${w.what}» — ${w.consecutiveFailures} проверок подряд не удались, приостановил. Проверьте условие, сэр.`);
      }
      this.store.update(w);
      return;
    }
    w.consecutiveFailures = 0; // успешная проверка (met или нет) — серия провалов сброшена
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
