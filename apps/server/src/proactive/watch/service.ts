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
import { autonomyFreeze } from "../../autonomy/freeze.js";
import { WatchStore } from "./store.js";
import { type CheckResult, type Watch, type WatchChecker, dueAt, watchActionFingerprint } from "./watch.js";

const log: Logger = createLogger("watch");

/** Сколько отложенных уведомлений отдаём за один заход (остальное — следующим тиком). См. flushPending. */
const FLUSH_BATCH = 2;
const FLUSH_DRAIN_MS = 20_000;

/** Потолок setTimeout (~24.8 дня): на больших интервалах спим максимум столько и пере-планируемся. */
const MAX_DELAY = 2 ** 31 - 1;
/** Волна E: пере-проверка «стоп ещё стоит?» замороженным тиком — пол задержки против busy-loop
 *  (созревшие watch'и дают delay=0), при этом цепочка таймеров ЖИВА и снятие стопа подхватится само. */
const FREEZE_RECHECK_MS = 30_000;

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
  /**
   * Self-heal (эпизод «перекрыл вкладку» 2026-07-24): вкладку перезагрузили/переоткрыли — её адрес
   * изменился. Патч ВПИСЫВАЕТСЯ в predicate наблюдения, иначе следующий тик стучался бы в мёртвый
   * tabId и наблюдение ослепло бы навсегда после первого же ремонта.
   */
  patch?: { tabId?: number; url?: string };
}

export class WatchService {
  private timer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private ticking = false; // защита от перекрытия тиков (checker асинхронный, может быть долгим)
  private readonly speakers = new Map<
    string,
    { userId: string; speak: (text: string, onOutcome?: (spoken: boolean) => void) => unknown }
  >();
  /** §Волна3 (3.4): каналы sendAction живых сессий — для предикат-наблюдений (проверка на клиенте). */
  private readonly actions = new Map<string, { userId: string; send: PredicateSender }>();
  /** P0 «watch действует» (2026-07-28): реестр запускателей агентской петли (реэнтри по срабатыванию). */
  private readonly runners = new Map<string, { userId: string; run: (goal: string) => void }>();
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
    /** P0 «watch действует»: отложенное поручение владельца — исполнить при срабатывании. */
    action?: string;
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
      ...(input.action?.trim() ? { action: input.action.trim() } : {}),
    };
    // F4 (волна F): одобрение владельца привязывается к СОДЕРЖИМОМУ операции (см. Watch.actionFingerprint) —
    // перед каждым исполнением действие сверяется с тем, что реально одобрялось на confirm.
    if (w.action) w.actionFingerprint = watchActionFingerprint(w);
    this.store.add(w);
    this.reschedule();
    log.info("наблюдение поставлено", { id: w.id, intervalMs: w.intervalMs, continuous: w.continuous, what: w.what.slice(0, 60) });
    return { ok: true, watch: w };
  }

  /** Снять наблюдение по id или по совпадению в `what` (последнее). Возвращает снятую запись или null.
   *  Адверс-ревью [3]: снимает и НЕВЫПОЛНЕННОЕ отложенное действие (pendingAction) — в т.ч. у уже
   *  fired/suspended записи (раньше поручение между срабатыванием и коннектом было неотменяемо). */
  cancel(idOrQuery: string, userId?: string): Watch | null {
    const byId = this.store.get(idOrQuery);
    // §sec (M12): by-id fast-path ТОЖЕ уважает userId-фильтр (как text-fallback ниже) — иначе, зная
    // эхнутый id, можно снять ЧУЖОЕ наблюдение. С userId — id обязан принадлежать этому пользователю.
    let target = byId && byId.status === "active" && (!userId || byId.userId === userId) ? byId : undefined;
    // Не-активная запись с висящим поручением — тоже отменяемая цель (только своя).
    let pendingOnly =
      byId && byId.status !== "active" && byId.pendingAction !== undefined && (!userId || byId.userId === userId) ? byId : undefined;
    if (!target && !pendingOnly) {
      const q = idOrQuery.toLowerCase().trim();
      const matches = this.store.list(userId ? { userId } : undefined).filter((w) => w.what.toLowerCase().includes(q));
      target = matches[matches.length - 1];
      if (!target && userId) {
        const pend = this.store.withPendingAction(userId).filter((w) => w.what.toLowerCase().includes(q));
        pendingOnly = pend[pend.length - 1];
      }
    }
    if (pendingOnly) {
      pendingOnly.pendingAction = undefined;
      pendingOnly.pendingActionAt = undefined;
      this.store.update(pendingOnly);
      log.info("наблюдение: отложенное действие снято (запись уже не активна)", { id: pendingOnly.id });
      return pendingOnly;
    }
    if (!target) return null;
    this.store.cancel(target.id);
    // Снятое наблюдение не должно оставить «мину»: висящее поручение уходит вместе с ним.
    if (target.pendingAction !== undefined) {
      target.pendingAction = undefined;
      target.pendingActionAt = undefined;
      this.store.update(target);
    }
    this.reschedule();
    log.info("наблюдение снято", { id: target.id });
    return target;
  }

  list(filter?: { sessionId?: string; userId?: string }): Watch[] {
    return this.store.list(filter);
  }

  /** Зарегистрировать канал озвучки сессии (с владельцем) и сразу отдать отложенные уведомления ЭТОГО юзера. */
  registerSpeaker(
    sessionId: string,
    userId: string,
    speak: (text: string, onOutcome?: (spoken: boolean) => void) => unknown,
  ): void {
    this.speakers.set(sessionId, { userId, speak });
    this.flushPending(userId);
  }

  /**
   * P0 «watch умеет ДЕЙСТВОВАТЬ» (аудит 2026-07-28): зарегистрировать запускатель агентской петли
   * сессии. Срабатывание наблюдения с `action` заходит в петлю как отложенное поручение владельца —
   * цепочка «событие → действие» больше не рвётся на пользователе. Регистрация сразу исполняет
   * действия, отложенные пока сессий не было (pendingAction — зеркало pendingNotify).
   */
  registerRunner(sessionId: string, userId: string, run: (goal: string) => void): void {
    this.runners.set(sessionId, { userId, run });
    this.flushPendingActions(userId);
  }

  unregisterRunner(sessionId: string): void {
    this.runners.delete(sessionId);
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
      // Self-heal: вкладку починили (перезагрузили/переоткрыли) → ФИКСИРУЕМ новый адрес в предикате,
      // чтобы следующий тик смотрел на живую вкладку, а не на мёртвый tabId (persist — в runCheck).
      if (r.patch && w.predicate && typeof w.predicate === "object") {
        const p = w.predicate as Record<string, unknown>;
        if (r.patch.tabId !== undefined) p.tabId = r.patch.tabId;
        if (r.patch.url) p.url = r.patch.url;
        log.info("наблюдение: вкладка восстановлена — адресация обновлена", { id: w.id, ...r.patch });
      }
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
      const data = res.data as
        | { met?: boolean; detail?: string; gsiState?: "fresh" | "stale" | "none"; unknown?: boolean }
        | undefined;
      // «НЕ СМОГ ПРОВЕРИТЬ» (сайдкар лёг, RPC-сбой, зависший опрос) — ТРАНЗИЕНТНАЯ ошибка, а не
      // достоверное «условие не выполняется» (финальное контрольное ревью 2026-07-28). Иначе один
      // моргнувший тик сбрасывал metStreak и следующий met запускал side-effect действие ПОВТОРНО
      // («второе письмо»/второй клик). Зеркало report{unknown:true} у LLM-чекера; transient=true —
      // не копится к dead-watch (сенсор вернётся).
      if (data?.unknown === true) {
        return {
          met: false,
          summary: "",
          error: `сенсор не смог проверить условие: ${(data.detail ?? "").slice(0, 120)}`,
          transient: true,
        };
      }
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
  private speakerFor(w: Watch): ((text: string, onOutcome?: (spoken: boolean) => void) => unknown) | undefined {
    const exact = this.speakers.get(w.sessionId);
    if (exact) return exact.speak;
    for (const s of this.speakers.values()) if (s.userId === w.userId) return s.speak;
    return undefined;
  }

  /**
   * Доставить уведомление (озвучить) — или пометить pendingNotify, если активной озвучки НЕТ либо она
   * ОТКАЗАЛА (контроль-8): раньше живой путь безусловно гасил pendingNotify и выставлял
   * `lastNotifiedSummary` — при полной очереди уведомление пропадало навсегда, а у continuous ещё и
   * включался антидребезг по тексту, который его глушил и в следующие разы.
   */
  private notify(w: Watch, summary: string): void {
    // Killswitch мог встать ПОСРЕДИ активного тика (контроль-ревью: гейт tickNow пройден ДО await
    // проверки) — уведомление честно паркуем, как при отсутствии сессии: снятие стопа отдаст штатно.
    if (autonomyFreeze().isFrozen()) {
      w.pendingNotify = summary;
      log.info("наблюдение сработало при «полном стопе» — уведомление отложено", { id: w.id });
      return;
    }
    const speak = this.speakerFor(w);
    // pendingNotify гасим ТОЛЬКО по факту ОЗВУЧКИ (контроль-9): «принято в очередь» ещё не
    // «прозвучало» (TTL/стоп/смерть сессии роняют принятое). Сначала помечаем «ждёт», снимает — колбэк.
    const accepted =
      speak !== undefined &&
      speak(summary, (spoken) => {
        if (spoken) return;
        // Откат (контроль-9): приняли, но не прозвучало → снова ждёт доставки.
        w.pendingNotify = summary;
        this.store.update(w);
        log.info("наблюдение: уведомление не прозвучало (очередь сбросила) — ждёт снова", { id: w.id });
        this.armDrain(w.userId);
      }) !== false;
    if (accepted) {
      w.lastNotifiedSummary = summary;
      w.pendingNotify = undefined;
      log.info("наблюдение: уведомление озвучено", { id: w.id });
    } else {
      w.pendingNotify = summary;
      log.info(
        speak
          ? "наблюдение: очередь озвучки не приняла — уведомление ждёт доставки"
          : "наблюдение сработало, но нет активной сессии — отложено до подключения",
        { id: w.id },
      );
      if (speak) this.armDrain(w.userId); // повторим, когда канал освободится
    }
  }

  /** Завести/продлить таймер дренажа отложенных уведомлений (общий для notify и flushPending). */
  private armDrain(userId: string): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.flushPending(userId);
    }, FLUSH_DRAIN_MS);
    if (typeof this.drainTimer === "object" && "unref" in this.drainTimer) this.drainTimer.unref?.();
  }

  /** Запускатель петли: точная сессия → любая сессия ТОГО ЖЕ userId (правило §6B/B3, как speakerFor). */
  private runnerFor(w: { sessionId: string; userId: string }): ((goal: string) => void) | undefined {
    const exact = this.runners.get(w.sessionId);
    if (exact && exact.userId === w.userId) return exact.run;
    for (const r of this.runners.values()) if (r.userId === w.userId) return r.run;
    return undefined;
  }

  /**
   * Реплика-реэнтри для агентской петли. ТОЛЬКО доверенные поля создания наблюдения (what/condition/
   * action — подтверждены владельцем через confirm при постановке); наблюдённое value НЕ включается —
   * текст со страницы/из игры не должен становиться инструкцией (анти-инъекция, M11). Фрейминг ЧЕСТНЫЙ
   * (адверс-ревью [10]): поручение поставлено ЗАРАНЕЕ при создании наблюдения, а не «владелец только
   * что сказал» — рискованное/чувствительное действие модель должна сверить с владельцем.
   */
  private actionGoal(w: Watch): string {
    return (
      `Сработало наблюдение «${w.what}» (условие: ${w.condition}). Выполни поручение, поставленное ЗАРАНЕЕ ` +
      `при создании этого наблюдения: ${w.action ?? ""}`.trim() +
      " Если действие выглядит рискованным или обстоятельства могли измениться — сначала уточни у владельца."
    );
  }

  /**
   * F4 (волна F): действие исполняется, только если запись СЕЙЧАС совпадает с тем, что владелец
   * одобрил при постановке (отпечаток). Разошлось → НЕ исполняем, ОДНО честное уведомление, watch
   * приостанавливается (одобренная единица «условие+действие» больше не существует — наблюдать её
   * дальше значило бы тикать в холостую с мёртвым действием). Легаси-запись без отпечатка (одобрена
   * до волны F) исполняется как раньше — ретро-блок сломал бы обещанные владельцу поручения.
   */
  private actionApprovalIntact(w: Watch): boolean {
    if (!w.actionFingerprint) {
      log.info("наблюдение: действие без отпечатка одобрения (легаси до волны F) — исполняю как раньше", { id: w.id });
      return true;
    }
    if (w.actionFingerprint === watchActionFingerprint(w)) return true;
    log.warn("наблюдение: операция ИЗМЕНИЛАСЬ после одобрения — действие не исполняю", { id: w.id });
    w.status = "suspended";
    w.pendingAction = undefined;
    w.pendingActionAt = undefined;
    this.notify(
      w,
      `Наблюдение «${w.what}» сработало, но его поручение изменилось после вашего одобрения — ` +
        `не стал выполнять и приостановил наблюдение. Поставьте заново, если нужно.`,
    );
    this.store.update(w);
    return false;
  }

  /** Запустить действие срабатывания (или отложить до появления живой сессии). */
  private dispatchAction(w: Watch): void {
    if (!w.action) return;
    if (!this.actionApprovalIntact(w)) return;
    // Анти-флап (контрольное ревью) решён В КОРНЕ: «нет данных» у LLM-чекера теперь возвращается как
    // ТРАНЗИЕНТНАЯ ошибка (report{unknown:true} → checker.ts), а не как достоверное «условие не
    // выполнено» — metStreak такой тик не сбрасывает, второго письма нет. Кулдаун по времени сюда НЕ
    // ставим: он давил бы и ЛЕГИТИМНЫЙ повтор («сборка упала → починили → упала снова через час»).
    w.lastActionAt = this.now(); // durable-след последнего запуска (диагностика/будущие политики)
    const goal = this.actionGoal(w);
    // Killswitch посреди тика (контроль-ревью): поручение ЛЮДЯМ после «полного стопа» исполняться
    // не должно — паркуем как «нет сессии»: pendingAction + TTL (протухшее честно не исполнится).
    const run = autonomyFreeze().isFrozen() ? undefined : this.runnerFor(w);
    if (!run) {
      w.pendingAction = goal;
      w.pendingActionAt = this.now(); // TTL: протухшее поручение не исполнится молча (адверс-ревью [3])
      log.info(
        autonomyFreeze().isFrozen()
          ? "наблюдение сработало при «полном стопе» — действие отложено (снятие стопа отдаст, TTL честен)"
          : "наблюдение сработало с действием, но нет живой сессии — действие отложено",
        { id: w.id },
      );
      return;
    }
    w.pendingAction = undefined;
    w.pendingActionAt = undefined;
    log.info("наблюдение: запускаю отложенное действие", { id: w.id, action: w.action.slice(0, 80) });
    try {
      run(goal);
    } catch (e) {
      log.warn("наблюдение: запуск действия упал", { id: w.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Отложенные ДЕЙСТВИЯ этого userId — исполнить через только что подключившуюся сессию.
   * TTL (адверс-ревью [3]): side-effect-поручение трёхдневной давности НЕ исполняется молча при
   * коннекте — владельцу честно сообщается, что оно устарело, решение за ним.
   */
  private flushPendingActions(userId: string): void {
    // Killswitch (волна E): отложенное ПОРУЧЕНИЕ — самое опасное, что есть у автономии (действие от
    // имени владельца). При стопе не исполняем и НЕ трогаем запись: снятие стопа отдаст её штатно
    // (TTL проверится в момент исполнения — протухшее честно не исполнится).
    if (autonomyFreeze().isFrozen()) return;
    const ttlMs = envInt("JARVIS_WATCH_PENDING_ACTION_TTL_MS", 30 * 60_000);
    for (const w of this.store.withPendingAction(userId)) {
      const run = this.runnerFor(w);
      if (!run || !w.pendingAction) continue;
      // F4: между парковкой и исполнением запись могла измениться — одобрение сверяется и здесь.
      if (!this.actionApprovalIntact(w)) continue;
      // 🔴 F4-контроль (HIGH): исполняем ПЕРЕСОБРАННЫЙ из СВЕРЕННЫХ полей goal, а не сохранённый
      // `w.pendingAction`. Отпечаток покрывает what|condition|action — а исполнялся свободный текст
      // pendingAction, в отпечаток не входящий: подмена ОДНОГО этого поля (что и есть заявленная
      // тред-модель «между парковкой и коннектом запись могла измениться») проходила сверку и
      // исполнялась дословно. actionGoal(w) даёт тот же текст, что клал dispatchAction, но из полей,
      // чью неизменность мы только что доказали.
      const goal = this.actionGoal(w);
      const ageMs = this.now() - (w.pendingActionAt ?? w.firedAt ?? w.createdAt);
      w.pendingAction = undefined;
      w.pendingActionAt = undefined;
      this.store.update(w);
      if (ageMs > ttlMs) {
        log.info("наблюдение: отложенное действие ПРОТУХЛО — не исполняю без подтверждения", { id: w.id, ageMin: Math.round(ageMs / 60_000) });
        this.notify(
          w,
          `Пока вас не было, сработало наблюдение «${w.what}», но поручение «${w.action ?? ""}» уже устарело ` +
            `(${Math.round(ageMs / 60_000)} мин назад) — не стал выполнять без подтверждения. Скажите, если ещё актуально.`,
        );
        this.store.update(w);
        continue;
      }
      log.info("наблюдение: отложенное действие исполняется при подключении", { id: w.id });
      try {
        run(goal);
      } catch (e) {
        log.warn("наблюдение: отложенное действие упало", { id: w.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** Отложенные уведомления ЭТОГО userId (включая сработавшие one-shot fired) — проговорить через только
   *  что подключившуюся сессию (приложение было закрыто в момент срабатывания). */
  /** Отдать отложенные уведомления ПОРЦИЕЙ (контроль-6): очередь озвучки капнута и вытесняет даже
   *  срочное, а мы гасим `pendingNotify` сразу — залп после долгого офлайна терял бы почти всё.
   *  Остаток остаётся в сторе и уйдёт следующим тиком наблюдений (`tickNow` зовёт flushPending). */
  private flushPending(userId: string): void {
    // Killswitch (волна E): проактивные уведомления при стопе не отдаём; pendingNotify цел в сторе —
    // дренаж возобновится тиками после «включи автономию».
    if (autonomyFreeze().isFrozen()) return;
    const queue = this.store.withPendingNotify(userId);
    let sent = 0;
    for (const w of queue) {
      if (sent >= FLUSH_BATCH) break;
      const speak = this.speakerFor(w);
      if (!speak || !w.pendingNotify) continue;
      // Гасим pendingNotify ТОЛЬКО если очередь озвучки приняла (контроль-7): очередь общая на все
      // проактивные каналы, «отдал» ≠ «прозвучит».
      const summary = w.pendingNotify;
      const ok =
        speak(summary, (spoken) => {
          if (spoken) return;
          w.pendingNotify = summary; // откат: не прозвучало
          this.store.update(w);
          log.info("наблюдение: отложенное уведомление не прозвучало — ждёт снова", { id: w.id });
          this.armDrain(userId);
        }) !== false;
      if (!ok) break;
      w.lastNotifiedSummary = summary;
      w.pendingNotify = undefined;
      this.store.update(w);
      log.info("наблюдение: отложенное уведомление доставлено", { id: w.id });
      sent += 1;
    }
    const left = queue.filter((w) => w.pendingNotify).length;
    if (left > 0) {
      log.info("наблюдения: уведомления отданы порцией, остаток ждёт дренажа", { остаток: left });
      // Свой таймер дренажа (контроль-7): `reschedule` заводит таймер ТОЛЬКО при непустом `active()`,
      // а хвост как раз копится у СРАБОТАВШИХ (status=fired) — без него остаток висел бы до реконнекта.
      this.armDrain(userId);
    }
  }

  /** Прогнать все созревшие проверки и пере-планироваться. Зовётся таймером; публичен для тестов/ручного
   *  триггера. Re-entrancy-гард: перекрывающийся вызов (долгий checker) — no-op. */
  async tickNow(): Promise<void> {
    if (this.ticking) return;
    // Killswitch (волна E): «полный стоп» замораживает проверки/уведомления/действия наблюдений;
    // записи store не трогаем (созревшее проверится после снятия стопа).
    // 🔴 КОНТРОЛЬ-РЕВЬЮ (HIGH): голый return здесь УБИВАЛ цепочку таймеров НАВСЕГДА — таймер у
    // WatchService one-shot и перевзводится ТОЛЬКО в finally этого метода (который ранний return
    // минует) — «включи автономию» снимал латч, а наблюдения молчали до рестарта (ложный ack).
    // Перевзводим явно и С ПОЛОМ задержки: обычный reschedule() на созревших watch'ах дал бы delay=0
    // → busy-loop setTimeout(0) на всё время стопа. Второй рубеж — «включи автономию» пинает tickNow.
    if (autonomyFreeze().isFrozen()) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.tickNow(), FREEZE_RECHECK_MS);
      if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
      return;
    }
    this.ticking = true;
    try {
      const now = this.now();
      // Хвост отложенных уведомлений (flushPending отдаёт их порцией — иначе очередь озвучки выбросит
      // помеченные доставленными) дренируем на каждом тике, а не только при подключении.
      for (const userId of new Set([...this.speakers.values()].map((s) => s.userId))) this.flushPending(userId);
      // Контроль-2 волны E (HIGH): pendingAction, запаркованный киллсвитчем ПОСРЕДИ тика (или при
      // реконнекте во время стопа), раньше ждал СЛЕДУЮЩЕГО registerRunner — «включи автономию»
      // пинает tickNow, значит тик обязан дренировать и ПОРУЧЕНИЯ, не только уведомления. TTL внутри
      // честен: протухшее не исполнится молча.
      for (const userId of new Set([...this.runners.values()].map((r) => r.userId))) this.flushPendingActions(userId);
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
    // КОНТРОЛЬНОЕ ревью: проверка асинхронна — за время await наблюдение могли СНЯТЬ (watch_cancel)
    // или приостановить. Без пере-проверки статуса снятое наблюдение всё равно исполнило бы action
    // и перезаписало бы `cancelled` на `fired` (ложное «сработало» после отмены).
    if (w.status !== "active") {
      log.info("наблюдение сняли во время проверки — исход отбрасываю", { id: w.id, status: w.status });
      return;
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
      // EDGE-ТРИГГЕР действия (адверс-ревью 2026-07-28 [1]): у LLM-чекера summary дрейфует (значение в
      // тексте меняется каждый тик при удерживающемся met) → строковый антидребезг промахивался и action
      // исполнялся ПОВТОРНО каждые ~5 мин. Действие привязано к ПЕРЕХОДУ not-met → met (durable metStreak),
      // а не к тексту уведомления.
      const freshMet = w.metStreak !== true;
      w.metStreak = true;
      // continuous: не дублируем идентичное уведомление подряд (антидребезг); состояние «отлипло» — снова уведомим.
      if (!(w.continuous && w.lastNotifiedSummary === summary)) {
        w.firedAt = this.now();
        this.notify(w, summary);
        if (!w.continuous) w.status = "fired"; // one-shot завершилось
      }
      // P0 «watch действует»: поручение «когда X — сделай Y» уходит в агентскую петлю ОДИН раз на
      // серию met (новый запуск — только после реального «отлипло»).
      if (freshMet) this.dispatchAction(w);
    } else {
      w.metStreak = false; // «отлипло» → следующий переход в met снова запустит действие
      if (w.continuous) {
        // состояние перестало удовлетворять условию → сбрасываем антидребезг (следующее met снова прозвучит).
        w.lastNotifiedSummary = undefined;
      }
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
