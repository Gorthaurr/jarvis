/**
 * Сервис напоминаний (§9): durable-store + ОДИН таймер next-wakeup + доставка проактивной речью.
 *
 * Главное исправление ревью 2026-06-18: раньше «напомни через N» делалось через code_run+sleep
 * (блокирующе, in-memory, не переживало рестарт) и НИКАК не доходило до озвучки сам по себе —
 * Джарвис «оживал» только когда с ним заговорят. Теперь: абсолютный fireAt в сторе, один таймер на
 * ближайшее событие, а в момент срабатывания фраза идёт в УЖЕ существующий канал проактивной речи
 * (тот же `speakQueued`, что озвучивает итоги фоновых задач) — клиент трогать не нужно.
 *
 * Доставка через реестр озвучек: router-ws регистрирует на сессию `speak(text)`; если активной сессии
 * нет (приложение закрыто) — напоминание помечается «сработало, ждёт доставки» и проговаривается при
 * следующем подключении (flushPending). Просроченные сверх grace при старте — пропускаем (не озвучиваем стухшее).
 */
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { Reminder } from "./reminder.js";
import { ReminderStore } from "./store.js";

const log: Logger = createLogger("reminders");

/** Потолок setTimeout (~24.8 дня): на больших интервалах спим максимум столько и пере-планируемся. */
const MAX_DELAY = 2 ** 31 - 1;

export interface ReminderServiceOpts {
  /** «сейчас» — для тестируемости. */
  now?: () => number;
  /** Просроченные при старте старше этого — пропускаем (не озвучиваем стухшее). По умолч. 6 ч. */
  graceMs?: number;
}

export class ReminderService {
  private timer?: ReturnType<typeof setTimeout>;
  // §6B/B3: канал озвучки + ВЛАДЕЛЕЦ (userId). Раньше был `Map<sessionId, speak>` и доставка падала в
  // ЛЮБУЮ сессию (any-speaker fallback) → чужое напоминание звучало у другого пользователя.
  private readonly speakers = new Map<string, { userId: string; speak: (text: string) => void }>();
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(
    private readonly store: ReminderStore = new ReminderStore(),
    opts: ReminderServiceOpts = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? 6 * 3600_000;
  }

  /** Старт: загрузить стор, отбросить стухшее, завести таймер на ближайшее. */
  async start(): Promise<void> {
    await this.store.load();
    this.catchUp();
    this.reschedule();
  }

  /**
   * Окно идемпотентности (мс): идентичный текст того же юзера с почти тем же fireAt в этом окне —
   * считаем ДУБЛЕМ и не создаём второй (корректная семантика «напомни X в T» = одно напоминание;
   * заодно глушит редкое двойное создание при наслоении ходов под нагрузкой). env-тюнинг.
   */
  private dedupWindowMs(): number {
    const n = Number.parseInt(process.env.JARVIS_REMINDER_DEDUP_MS ?? "", 10);
    return Number.isFinite(n) ? Math.max(0, n) : 15_000;
  }

  /** Поставить напоминание. fireAt уже вычислен сервером (resolveFireAt). Возвращает запись (или существующий дубль). */
  add(input: { sessionId: string; userId: string; text: string; fireAt: number }): Reminder {
    // Идемпотентность: тот же userId + тот же текст + fireAt в окне → возвращаем СУЩЕСТВУЮЩИЙ, не плодим.
    const text = input.text.trim();
    const win = this.dedupWindowMs();
    const dup = this.store
      .list({ userId: input.userId })
      .find((e) => e.text.trim().toLowerCase() === text.toLowerCase() && Math.abs(e.fireAt - input.fireAt) <= win);
    if (dup) {
      log.info("напоминание-дубль — возвращаю существующее (идемпотентность)", { id: dup.id });
      return dup;
    }
    const r: Reminder = {
      id: newId(),
      sessionId: input.sessionId,
      userId: input.userId,
      fireAt: input.fireAt,
      text: input.text.trim(),
      status: "scheduled",
      createdAt: this.now(),
    };
    this.store.add(r);
    this.reschedule();
    log.info("напоминание поставлено", { id: r.id, fireAt: r.fireAt, inMs: r.fireAt - this.now() });
    return r;
  }

  /** Отменить по id или по тексту-запросу (последнее совпадение). Возвращает отменённую запись или null. */
  cancel(idOrQuery: string, sessionId?: string): Reminder | null {
    const byId = this.store.get(idOrQuery);
    let target = byId && byId.status === "scheduled" ? byId : undefined;
    if (!target) {
      const q = idOrQuery.toLowerCase().trim();
      const matches = this.store
        .list(sessionId ? { sessionId } : undefined)
        .filter((r) => r.text.toLowerCase().includes(q));
      target = matches[matches.length - 1];
    }
    if (!target) return null;
    this.store.cancel(target.id);
    this.reschedule();
    return target;
  }

  list(sessionId?: string): Reminder[] {
    return this.store.list(sessionId ? { sessionId } : undefined);
  }

  /** Зарегистрировать канал озвучки сессии (с владельцем-userId) и сразу отдать накопленные недоставленные ЭТОГО юзера. */
  registerSpeaker(sessionId: string, userId: string, speak: (text: string) => void): void {
    this.speakers.set(sessionId, { userId, speak });
    this.flushPending(sessionId, userId);
  }

  unregisterSpeaker(sessionId: string): void {
    this.speakers.delete(sessionId);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ── внутреннее ──────────────────────────────────────────────

  /** Канал озвучки для напоминания: точная сессия → ЛЮБАЯ сессия ТОГО ЖЕ userId (мульти-девайс/reconnect
   *  с новым sessionId) → undefined. НИКОГДА не падаем в сессию ДРУГОГО пользователя (фикс утечки). */
  private speakerFor(r: Reminder): ((text: string) => void) | undefined {
    const exact = this.speakers.get(r.sessionId);
    if (exact) return exact.speak;
    for (const s of this.speakers.values()) if (s.userId === r.userId) return s.speak;
    return undefined;
  }

  /** Доставить (озвучить) — или пометить «ждёт доставки», если активной озвучки нет. */
  private deliver(r: Reminder): void {
    const speak = this.speakerFor(r);
    if (speak) {
      speak(r.text);
      this.store.setStatus(r.id, "done", this.now());
      log.info("напоминание озвучено", { id: r.id });
    } else {
      this.store.markFiredUndelivered(r.id, this.now());
      log.info("напоминание сработало, но нет активной сессии — отложено до подключения", { id: r.id });
    }
  }

  /** Сработавшие, но недоставленные ЭТОГО userId — проговорить через только что подключившуюся сессию.
   *  §6B/B3: фильтр по userId (не sessionId) — отложенное переживает reconnect (новый sessionId) и НЕ
   *  утекает чужому пользователю. */
  private flushPending(sessionId: string, userId: string): void {
    const entry = this.speakers.get(sessionId);
    if (!entry) return;
    for (const r of this.store.awaitingDelivery({ userId })) {
      entry.speak(r.text);
      this.store.setStatus(r.id, "done", r.firedAt);
      log.info("отложенное напоминание доставлено при подключении", { id: r.id });
    }
  }

  /** Срабатывание таймера: озвучить все наступившие, пере-планироваться. */
  private tick(): void {
    const now = this.now();
    for (const r of this.store.scheduledPending().filter((r) => r.fireAt <= now)) this.deliver(r);
    this.store.prune(now);
    this.reschedule();
  }

  /** Один таймер на ближайшее напоминание (next-wakeup), большие интервалы — кусками по MAX_DELAY. */
  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const next = this.store.nextPending();
    if (!next) return;
    const delay = Math.min(MAX_DELAY, Math.max(0, next.fireAt - this.now()));
    this.timer = setTimeout(() => this.tick(), delay);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
  }

  /** При старте: слишком старые (сверх grace) — пропустить, чтобы не озвучивать стухшее. */
  private catchUp(): void {
    const now = this.now();
    for (const r of this.store.scheduledPending()) {
      if (r.fireAt <= now - this.graceMs) {
        this.store.setStatus(r.id, "done", now);
        log.info("напоминание просрочено сверх grace — пропущено", { id: r.id });
      }
    }
  }
}
