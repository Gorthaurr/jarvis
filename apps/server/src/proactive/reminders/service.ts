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
import {
  type Reminder,
  type RepeatRule,
  nextFireAfter,
  sameReminderSubject,
  sameSeriesSlot,
  seriesCoversMoment,
} from "./reminder.js";
import { ReminderStore } from "./store.js";

const log: Logger = createLogger("reminders");

/** Потолок setTimeout (~24.8 дня): на больших интервалах спим максимум столько и пере-планируемся. */
const MAX_DELAY = 2 ** 31 - 1;

/** Сколько недоставленных напоминаний отдаём за один заход и через сколько дренируем остаток.
 *  Очередь озвучки капнута и при переполнении вытесняет даже СРОЧНОЕ, а мы помечаем `done` сразу —
 *  залп после суток офлайна терял бы почти всё (контроль-6 волны D). */
const FLUSH_BATCH = 2;
const FLUSH_DRAIN_MS = 20_000;

export interface ReminderServiceOpts {
  /** «сейчас» — для тестируемости. */
  now?: () => number;
  /** Просроченные при старте старше этого — пропускаем (не озвучиваем стухшее). По умолч. 6 ч. */
  graceMs?: number;
}

export class ReminderService {
  private timer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  // §6B/B3: канал озвучки + ВЛАДЕЛЕЦ (userId). Раньше был `Map<sessionId, speak>` и доставка падала в
  // ЛЮБУЮ сессию (any-speaker fallback) → чужое напоминание звучало у другого пользователя.
  /** speak возвращает false, если очередь озвучки НЕ приняла реплику (тогда запись остаётся
   *  недоставленной и будет повторена) — см. VoicePipeline.speakQueued. void = старые вызывающие. */
  private readonly speakers = new Map<
    string,
    { userId: string; speak: (text: string, onOutcome?: (spoken: boolean) => void) => unknown }
  >();
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

  /** Поставить напоминание. fireAt уже вычислен сервером (resolveFireAt). Возвращает запись (или существующий дубль).
   *  `repeat` (волна D) — правило повтора; пусто = одноразовое (прежнее поведение). */
  add(input: { sessionId: string; userId: string; text: string; fireAt: number; repeat?: RepeatRule }): Reminder & { created?: boolean } {
    // Идемпотентность: тот же userId + тот же текст + fireAt в окне → возвращаем СУЩЕСТВУЮЩИЙ, не плодим.
    const text = input.text.trim();
    const win = this.dedupWindowMs();
    // 🔴 РИТМ УЧАСТВУЕТ ВО ВСЕХ ГЕЙТАХ (контроль волны D, HIGH): раньше повторяющееся напоминание
    // схлопывалось в существующее ОДНОРАЗОВОЕ (рефлекс ставит разовое → петля следом ставит серию),
    // серия молча не создавалась, а хендлер рапортовал «поставлено» — masked failure.
    const sameRhythm = (e: Reminder): boolean => {
      if (!input.repeat && !e.repeat) return true; // оба одноразовые
      if (!input.repeat || !e.repeat) return false; // разовое ≠ серия
      if (e.repeat.kind !== input.repeat.kind) return false;
      if (e.repeat.kind === "interval" && input.repeat.kind === "interval") return e.repeat.seconds === input.repeat.seconds;
      return true;
    };
    // УЖЕ СРАБОТАВШИЕ (ждут доставки офлайн-владельцу) в дедупе НЕ участвуют (контроль-5): их момент
    // в ПРОШЛОМ, поэтому «схлопнуть» в них новую просьбу — значит молча потерять новое дело и
    // подтвердить владельцу время, которое уже наступило. Тот же гард стоит у поглощения серией.
    const pendingList = () => this.store.list({ userId: input.userId }).filter((e) => e.firedAt === undefined);
    const dup = pendingList().find(
      (e) =>
        e.text.trim().toLowerCase() === text.toLowerCase() &&
        Math.abs(e.fireAt - input.fireAt) <= win &&
        sameRhythm(e),
    );
    if (dup) {
      log.info("напоминание-дубль — возвращаю существующее (идемпотентность)", { id: dup.id });
      return { ...dup, created: false };
    }
    // ОДНО ДЕЛО — ОДНО НАПОМИНАНИЕ (волна D, живой смоук): рефлекс обязательств и основная петля,
    // услышав одну реплику, ставили ДВА напоминания об одном деле с разными формулировками и временем
    // (10:00 и 11:00) — владелец получил бы два звонка. Точная идемпотентность выше такое не ловит,
    // поэтому сверяем СУТЬ и близость времени (окно JARVIS_REMINDER_SUBJECT_WINDOW_MS, деф 2ч).
    const subjWin = (() => {
      const n = Number.parseInt(process.env.JARVIS_REMINDER_SUBJECT_WINDOW_MS ?? "", 10);
      return Number.isFinite(n) && n >= 0 ? n : 2 * 3600_000;
    })();
    if (subjWin > 0) {
      const sameSubject = pendingList().find(
        (e) =>
          // ТОЧНО такой же текст сюда НЕ относится: это осознанный повтор владельца («позвонить маме»
          // в 10:00 и в 18:00 — два разных дела), его судит узкий гард идемпотентности выше.
          e.text.trim().toLowerCase() !== text.toLowerCase() &&
          Math.abs(e.fireAt - input.fireAt) <= subjWin &&
          sameRhythm(e) && // серию НЕ схлопываем в разовое (и наоборот) — см. sameRhythm выше
          sameReminderSubject(e.text, text),
      );
      if (sameSubject) {
        log.info("напоминание об уже запланированном деле — возвращаю существующее", {
          id: sameSubject.id,
          existing: sameSubject.text.slice(0, 50),
          incoming: text.slice(0, 50),
        });
        return { ...sameSubject, created: false };
      }
    }
    // Волна D: ВТОРАЯ СЕРИЯ с тем же текстом и ритмом не создаётся (иначе «напоминай каждый день пить
    // таблетки», сказанное дважды в разные дни, звонило бы дважды в день — окно fireAt-дедупа выше
    // такой случай не ловит, потому что первая серия уже уехала на следующие сутки).
    if (input.repeat) {
      const sameSeries = this.store.list({ userId: input.userId }).find(
        (e) =>
          e.repeat?.kind === input.repeat?.kind &&
          (e.repeat?.kind !== "interval" || e.repeat.seconds === (input.repeat as { seconds?: number }).seconds) &&
          e.text.trim().toLowerCase() === text.toLowerCase() &&
          // ...И ТОТ ЖЕ СЛОТ (ревью волны D, HIGH): «каждый день в 9 утра» и «каждый день в 9 вечера» —
          // РАЗНЫЕ серии; без этой сверки вечерняя молча терялась, а хендлер рапортовал успех.
          sameSeriesSlot(input.repeat!, e.fireAt, input.fireAt),
      );
      if (sameSeries) {
        log.info("повторяющееся напоминание уже есть — возвращаю существующую серию", { id: sameSeries.id });
        return { ...sameSeries, created: false };
      }
    }
    // 🔴 СЕРИЯ И РАЗОВОЕ НА ОДНОМ СЛОТЕ (контроль-2 волны D, HIGH — регрессия предыдущего фикса).
    // sameRhythm выше правильно перестал схлопывать серию в разовое, но вторую половину работы не делал:
    // обе записи доживали до общего слота, и владелец слышал одно и то же ДВАЖДЫ подряд (рефлекс
    // обязательств ставит разовое, основная петля следом — серию с тем же делом и временем). Одну боль
    // (молчаливая потеря ритма) нельзя менять на другую (дубль в ухо), поэтому слот разводим явно:
    //   • создаём СЕРИЮ → перекрытое разовое того же дела СНИМАЕМ (серия его покрывает);
    //   • создаём РАЗОВОЕ, а серия на этот слот уже есть → отдаём серию (created:false), второй не плодим.
    const sameThing = (a: string, b: string): boolean =>
      a.trim().toLowerCase() === b.trim().toLowerCase() || sameReminderSubject(a, b);
    // Снимать/подавлять разовое можно ТОЛЬКО если серия РЕАЛЬНО прозвучит в тот же момент
    // (`seriesCoversMoment`, не просто «то же время суток»): иначе «по будням в 9:00» съедало субботнее
    // напоминание, а серия, стартующая завтра, — сегодняшнее. Молча потерянное дело + бодрое
    // «Напоминание поставлено» — ровно тот ложный успех, который здесь и чинится.
    // Записи с `firedAt` (сработали, ждут доставки офлайн-владельцу) НЕ трогаем — их отмена означала бы,
    // что уже наступившее напоминание не прозвучит никогда.
    if (input.repeat) {
      for (const e of this.store.list({ userId: input.userId })) {
        if (e.repeat || e.status !== "scheduled" || e.firedAt !== undefined) continue;
        if (!sameThing(e.text, text) || !seriesCoversMoment(input.repeat, input.fireAt, e.fireAt)) continue;
        this.store.cancel(e.id);
        log.info("разовое напоминание поглощено новой серией того же дела (иначе прозвучало бы дважды)", {
          cancelled: e.id,
          text: e.text.slice(0, 50),
        });
      }
    } else {
      const covering = this.store
        .list({ userId: input.userId })
        .find((e) => e.repeat && e.status === "scheduled" && sameThing(e.text, text) && seriesCoversMoment(e.repeat, e.fireAt, input.fireAt));
      if (covering) {
        log.info("это дело уже покрыто серией на тот же слот — второго напоминания не ставлю", { id: covering.id });
        return { ...covering, created: false };
      }
    }
    const id = newId();
    const r: Reminder = {
      id,
      sessionId: input.sessionId,
      userId: input.userId,
      fireAt: input.fireAt,
      text: input.text.trim(),
      status: "scheduled",
      createdAt: this.now(),
      ...(input.repeat ? { repeat: input.repeat, seriesId: id } : {}),
    };
    this.store.add(r);
    this.reschedule();
    log.info("напоминание поставлено", { id: r.id, fireAt: r.fireAt, inMs: r.fireAt - this.now(), repeat: input.repeat?.kind });
    return { ...r, created: true };
  }

  /**
   * Отменить по id или по тексту-запросу (последнее совпадение). Возвращает отменённую запись или null.
   *
   * 🔴 ФИЛЬТР ПО ВЛАДЕЛЬЦУ, НЕ ПО СЕССИИ (волна D, разведка): sessionId живёт в ОЗУ и МЕНЯЕТСЯ на
   * каждом переподключении/рестарте сервера, поэтому «отмени напоминание про зал» назавтра не находило
   * НИЧЕГО — напоминание продолжало звонить, а Джарвис честно отвечал «не нашёл». Для повторяющихся
   * это блокирующе (серию нельзя было прекратить). Изоляция между пользователями сохранена: userId.
   */
  cancel(idOrQuery: string, userId?: string): Reminder | null {
    const byId = this.store.get(idOrQuery);
    // §sec (L2): by-id fast-path ТОЖЕ уважает фильтр владельца — иначе, зная эхнутый id, можно снять ЧУЖОЕ.
    let target = byId && byId.status === "scheduled" && (!userId || byId.userId === userId) ? byId : undefined;
    if (!target) {
      const q = idOrQuery.toLowerCase().trim();
      const matches = this.store
        .list(userId ? { userId } : undefined)
        .filter((r) => r.text.toLowerCase().includes(q));
      target = matches[matches.length - 1];
    }
    if (!target) return null;
    this.store.cancel(target.id);
    // Отмена ПОВТОРЯЮЩЕГОСЯ = прекращение ВСЕЙ серии: снимаем и другие живые экземпляры того же ряда
    // (их порождает планировщик, и без этого серия воскресла бы следующим срабатыванием).
    const series = target.seriesId;
    if (series) {
      for (const other of this.store.list({ userId: target.userId })) {
        if (other.id !== target.id && (other.seriesId ?? other.id) === series) this.store.cancel(other.id);
      }
    }
    this.reschedule();
    return target;
  }

  /** Активные напоминания ВЛАДЕЛЬЦА (не сессии — sessionId меняется на переподключении, см. cancel). */
  list(userId?: string): Reminder[] {
    return this.store.list(userId ? { userId } : undefined);
  }

  /** Зарегистрировать канал озвучки сессии (с владельцем-userId) и сразу отдать накопленные недоставленные ЭТОГО юзера. */
  registerSpeaker(
    sessionId: string,
    userId: string,
    speak: (text: string, onOutcome?: (spoken: boolean) => void) => unknown,
  ): void {
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

  /** M13: дождаться отложенных записей стора (graceful shutdown) — иначе отменённое напоминание,
   *  чья запись не успела лечь на диск, всё равно «сработает» после рестарта. */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  // ── внутреннее ──────────────────────────────────────────────

  /** Канал озвучки для напоминания: точная сессия → ЛЮБАЯ сессия ТОГО ЖЕ userId (мульти-девайс/reconnect
   *  с новым sessionId) → undefined. НИКОГДА не падаем в сессию ДРУГОГО пользователя (фикс утечки). */
  private speakerFor(r: Reminder): { sessionId: string; speak: (t: string, cb?: (spoken: boolean) => void) => unknown } | undefined {
    const exact = this.speakers.get(r.sessionId);
    if (exact) return { sessionId: r.sessionId, speak: exact.speak };
    // ЖИВОЙ канал может принадлежать ДРУГОЙ сессии того же владельца (рестарт/reconnect минтит новый
    // sessionId, а серия несёт исходный) — возвращаем id ИМЕННО живого: дренаж по мёртвому id уходил
    // в никуда и вешал весь хвост недоставленных (контроль-9).
    for (const [sid, sp] of this.speakers) if (sp.userId === r.userId) return { sessionId: sid, speak: sp.speak };
    return undefined;
  }

  /** Доставить (озвучить) — или пометить «ждёт доставки», если активной озвучки нет ИЛИ она отказала. */
  private deliver(r: Reminder): void {
    const ch = this.speakerFor(r);
    // ОЧЕРЕДЬ МОГЛА ОТКАЗАТЬ (контроль-8): здесь ЖИВОЙ путь срабатывания при подключённом владельце,
    // и раньше он безусловно ставил `done` — при полной очереди напоминание не звучало НИКОГДА, а лог
    // рапортовал «озвучено». Тип `speakerFor` был `=> void`, что и прятало исход (и блокировало бы
    // проверку компилятором). Отказ = ровно та же ситуация, что «нет сессии»: ждём доставки.
    // ПОМЕЧАЕМ ДОСТАВЛЕННЫМ ТОЛЬКО ПО ФАКТУ ОЗВУЧКИ (контроль-9): «принято в очередь» ещё не
    // «прозвучало» — очередь роняет по TTL, на «стоп» и на смерти сессии. Сначала ставим «ждёт
    // доставки», а `done` выставляет колбэк исхода. Так ни один путь сброса не теряет дело молча.
    const accepted =
      ch !== undefined &&
      ch.speak(r.text, (spoken) => {
        if (spoken) return;
        // Приняли, но не прозвучало (TTL/«стоп»/смерть сессии) → ОТКАТЫВАЕМ `done` (контроль-9).
        this.store.markFiredUndelivered(r.id, this.now());
        log.info("напоминание не прозвучало (очередь сбросила) — снова ждёт доставки", { id: r.id });
        this.armDrain(ch.sessionId, r.userId);
      }) !== false;
    if (accepted) {
      this.store.setStatus(r.id, "done", this.now());
      log.info("напоминание озвучено", { id: r.id });
    } else {
      this.store.markFiredUndelivered(r.id, this.now());
      log.info(
        ch
          ? "напоминание сработало, но очередь озвучки не приняла — ждёт доставки"
          : "напоминание сработало, но нет активной сессии — отложено до подключения",
        { id: r.id },
      );
      if (ch) this.armDrain(ch.sessionId, r.userId); // повторим, когда канал освободится
    }
    this.scheduleNextOccurrence(r); // волна D: повторяющееся живёт дальше
  }

  /** Завести/продлить таймер дренажа недоставленных (общий для deliver и flushPending). */
  private armDrain(sessionId: string, userId: string): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.flushPending(sessionId, userId);
    }, FLUSH_DRAIN_MS);
    if (typeof this.drainTimer === "object" && "unref" in this.drainTimer) this.drainTimer.unref?.();
  }

  /**
   * Волна D: поставить СЛЕДУЮЩЕЕ срабатывание серии. Отдельная запись (id новый) — так отмена уже
   * доставленного экземпляра не убивает серию, а `cancel` активной записи прекращает её штатно.
   * Одноразовое напоминание (repeat пуст) сюда не попадает.
   */
  private scheduleNextOccurrence(r: Reminder): void {
    if (!r.repeat) return;
    const next = nextFireAfter(r.repeat, r.fireAt, this.now());
    if (next === null) return;
    const series = r.seriesId ?? r.id;
    // СХЛОПЫВАНИЕ ПРОПУЩЕННЫХ (разведка волны D): экземпляры серии, сработавшие в тишину (клиент был
    // закрыт), висят «ждут доставки». Без этого трое суток офлайна = три одинаковых «Пить таблетки»
    // подряд urgent'ом при подключении (QUEUE_MAX вытесняет только НЕсрочные — защиты бы не было).
    // Свежее срабатывание делает прошлые неактуальными: владелец услышит ОДНО.
    for (const stale of this.store.awaitingDelivery({ userId: r.userId })) {
      if ((stale.seriesId ?? stale.id) === series && stale.id !== r.id) {
        this.store.setStatus(stale.id, "done", stale.firedAt);
        log.info("повтор: прошлое недоставленное срабатывание схлопнуто (не звучим пачкой)", { id: stale.id });
      }
    }
    const copy: Reminder = {
      id: newId(),
      sessionId: r.sessionId,
      userId: r.userId,
      fireAt: next,
      text: r.text,
      status: "scheduled",
      createdAt: this.now(),
      repeat: r.repeat,
      seriesId: series,
    };
    this.store.add(copy);
    log.info("повторяющееся напоминание: следующее срабатывание запланировано", {
      id: copy.id,
      fireAt: copy.fireAt,
      repeat: r.repeat.kind,
    });
  }

  /** Сработавшие, но недоставленные ЭТОГО userId — проговорить через только что подключившуюся сессию.
   *  §6B/B3: фильтр по userId (не sessionId) — отложенное переживает reconnect (новый sessionId) и НЕ
   *  утекает чужому пользователю. */
  /**
   * Отдать недоставленные напоминания подключившемуся владельцу — ПОРЦИЕЙ (контроль-6 волны D).
   * Залпом нельзя: очередь озвучки капнута и при переполнении вытесняет даже СРОЧНОЕ, а мы помечаем
   * `done` СРАЗУ — сутки офлайна превращали шесть будильников в один прозвучавший и пять потерянных
   * навсегда. Остаток остаётся `awaitingDelivery` и уйдёт следующим тиком таймера/подключением.
   */
  private flushPending(sessionId: string, userId: string): void {
    const entry = this.speakers.get(sessionId);
    if (!entry) return;
    const queue = this.store.awaitingDelivery({ userId });
    let sent = 0;
    for (const r of queue.slice(0, FLUSH_BATCH)) {
      // Помечаем `done` ТОЛЬКО по факту ОЗВУЧКИ (контроль-7 и -9): очередь общая на все проактивные
      // каналы, «отдал» ≠ «принято», а «принято» ≠ «прозвучало» (TTL/стоп/смерть сессии).
      const ok =
        entry.speak(r.text, (spoken) => {
          if (spoken) return;
          this.store.markFiredUndelivered(r.id, r.firedAt ?? this.now()); // откат: не прозвучало
          log.info("отложенное напоминание не прозвучало (очередь сбросила) — ждёт снова", { id: r.id });
          this.armDrain(sessionId, userId);
        }) !== false;
      if (!ok) break;
      this.store.setStatus(r.id, "done", r.firedAt);
      log.info("отложенное напоминание доставлено", { id: r.id });
      sent += 1;
    }
    const left = queue.length - sent;
    if (left > 0) {
      log.info("отложенные напоминания отданы порцией, остаток ждёт", { остаток: left });
      // Собственный таймер дренажа: `reschedule` смотрит только на БУДУЩИЕ напоминания и хвост
      // недоставленных не увидел бы (при пустом расписании таймера нет вовсе → хвост завис бы навсегда).
      this.armDrain(sessionId, userId);
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
        // Волна D: у ПОВТОРЯЮЩЕГОСЯ пропуск одного слота не должен убивать серию (ПК был выключен →
        // «каждый день пить таблетки» иначе замолчало бы навсегда). Стухшее НЕ озвучиваем, но
        // следующий будущий слот планируем — владелец получит ОДНО напоминание, а не пачку «за вчера».
        this.scheduleNextOccurrence(r);
      }
    }
  }
}
