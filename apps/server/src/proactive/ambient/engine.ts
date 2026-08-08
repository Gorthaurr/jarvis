/**
 * ДВИЖОК ambient-осведомлённости: периодически и ДЁШЕВО опрашивает источники, дедуплицирует новые сигналы,
 * фильтрует по САЛИЕНТНОСТИ и проактивно проговаривает важное (тот же speaker-registry, что напоминания/watch,
 * §6B/B3 изоляция по userId; уважает «не мешать» §9 через speakQueued). LLM-фразировщик зовётся ТОЛЬКО на
 * НОВЫЙ салиентный сигнал — токен-эконом как качество (тики сами по себе бесплатны).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { autonomyFreeze } from "../../autonomy/freeze.js";
import { type QuietWindow, inQuietWindow, parseQuietWindow } from "../quiet-hours.js";
import { AmbientSeenStore } from "./store.js";
import type { AmbientPhraser, AmbientSignal, AmbientSource } from "./signal.js";

const log: Logger = createLogger("ambient");

/** Сколько НЕсрочных отложенных отдаём за один заход: очередь озвучки держит немного и вытесняет
 *  старейшие, поэтому остальное ждёт следующего тика, а не помечается доставленным впустую. */
const FLUSH_BATCH = 2;

/** Сколько НЕсрочных сигналов озвучиваем за ОДИН тик. Сверх — ждут следующего (ничего не помечаем). */
const TICK_SPEAK_BUDGET = 2;

export interface AmbientEngineOpts {
  now?: () => number;
  /** Период опроса источников (мс). Деф 90с (env JARVIS_AMBIENT_INTERVAL_MS). Дёшево → можно часто. */
  intervalMs?: number;
  /** Порог салиентности [0..1]: ниже — не тревожим владельца. Деф 0.5 (env JARVIS_AMBIENT_MIN_SALIENCE). */
  minSalience?: number;
  /** LLM-фразировщик (опц.): сырой сигнал → дворецкая фраза. Зовётся лишь на НОВОЕ важное. null → title как есть. */
  phraser?: AmbientPhraser;
  /** Тихие часы (волна E): спека окна для тестов; деф — env JARVIS_QUIET_HOURS ("23-9", пусто=выкл). */
  quietHours?: string;
}

export class AmbientEngine {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly speakers = new Map<
    string,
    { userId: string; speak: (text: string, urgent: boolean, onOutcome?: (spoken: boolean) => void) => unknown; isBusy?: () => boolean }
  >();
  /** Недоставленное (сессии не было в момент сигнала) → проговорить при подключении владельца. */
  private pending: Array<{ userId: string; text: string; urgent: boolean; seenKey: string; expiresAt?: number }> = [];
  /** Аудит-2 [6]: сигналы, поставленные в pending В ЭТОМ ПРОЦЕССЕ (анти-дубль на тиках), НЕ persist —
   *  durable «seen» ставится ЛИШЬ при реальной доставке, иначе рестарт до flush терял бы срочный сигнал. */
  private readonly queuedKeys = new Set<string>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly minSalience: number;
  private readonly phraser?: AmbientPhraser;
  /** Тихие часы: null = выкл; парсится ЛЕНИВО (грабля «.env грузится после ESM-хойст-импортов»). */
  private quietWindow: QuietWindow | null | undefined;
  private readonly quietSpec?: string;

  constructor(
    private readonly sources: AmbientSource[],
    private readonly store: AmbientSeenStore = new AmbientSeenStore(),
    opts: AmbientEngineOpts = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? envInt("JARVIS_AMBIENT_INTERVAL_MS", 90_000);
    this.minSalience = opts.minSalience ?? envFloat("JARVIS_AMBIENT_MIN_SALIENCE", 0.5);
    this.phraser = opts.phraser;
    if (opts.quietHours !== undefined) this.quietSpec = opts.quietHours;
  }

  /** Волна E: сейчас тихие часы? Несрочный ambient не озвучиваем (семантика ровно как «занят»):
   *  seen НЕ ставится, сигнал вернётся следующим тиком и прозвучит после конца окна. */
  private inQuiet(): boolean {
    if (this.quietWindow === undefined) {
      this.quietWindow = parseQuietWindow(this.quietSpec ?? process.env.JARVIS_QUIET_HOURS);
      if (this.quietWindow) log.info("ambient: тихие часы активны", { окно: this.quietSpec ?? process.env.JARVIS_QUIET_HOURS });
    }
    return this.quietWindow !== null && inQuietWindow(this.quietWindow, new Date(this.now()));
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

  /**
   * Зарегистрировать канал озвучки сессии (с владельцем) и сразу отдать отложенные ЭТОГО юзера.
   * isBusy (опц.) — «владелец сейчас занят» (§9): несрочное не отдаём, чтобы очередь его не выбросила.
   */
  registerSpeaker(
    sessionId: string,
    userId: string,
    speak: (text: string, urgent: boolean, onOutcome?: (spoken: boolean) => void) => unknown,
    isBusy?: () => boolean,
  ): void {
    this.speakers.set(sessionId, { userId, speak, ...(isBusy ? { isBusy } : {}) });
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
    // Killswitch (волна E): «полный стоп» замораживает ambient-опросы целиком (сигналы никуда не
    // деваются — источники отдадут их после «включи автономию»; таймер жив).
    if (autonomyFreeze().isFrozen()) return;
    this.ticking = true;
    try {
      // Сначала дренируем остаток прошлой порции отложенных (flushPending отдаёт их не разом, чтобы
      // очередь озвучки не выбросила помеченные доставленными) — иначе хвост завис бы до реконнекта.
      for (const userId of new Set([...this.speakers.values()].map((s) => s.userId))) this.flushPending(userId);
      // БЮДЖЕТ ОЗВУЧКИ НА ТИК (контроль-6): очередь пайплайна держит немного и вытесняет старейшие,
      // поэтому за один проход отдаём ограниченное число НЕсрочных. Сверх бюджета сигнал НЕ трогаем
      // вовсе (ни seen, ни pending) — на следующем тике он рассмотрится снова и дойдёт до владельца.
      // Так «важное письмо под тремя рассылками» не голодает: рассылки уходят ниже порога и бюджет не
      // тратят, а всё, что не влезло, просто ждёт следующего тика.
      const budget = { left: TICK_SPEAK_BUDGET };
      // Сперва СОБИРАЕМ со всех источников, потом рассматриваем ПО УБЫВАНИЮ ВАЖНОСТИ (контроль-7):
      // раздача бюджета в порядке массива источников голодала важное — «через 20 мин созвон»
      // (salience 0.9) не звучал НИ РАЗУ, пока в Telegram шла переписка (0.7), потому что telegram
      // стоит в списке раньше. Приоритет должен решать смысл сигнала, а не порядок регистрации.
      const collected: AmbientSignal[] = [];
      for (const src of this.sources) {
        if (!src.enabled()) continue;
        try {
          collected.push(...(await src.poll()));
        } catch (e) {
          log.info("ambient: источник не отдал сигналы (пропуск)", { source: src.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      collected.sort((a, b) => (b.urgent === true ? 1 : 0) - (a.urgent === true ? 1 : 0) || b.salience - a.salience);
      for (const sig of collected) await this.consider(sig, budget);
      this.store.prune(this.now());
    } finally {
      this.ticking = false;
    }
  }

  // ── внутреннее ──────────────────────────────────────────────

  /** Рассмотреть один сигнал: новый (не seen) + салиентный → сформулировать и проактивно сообщить. */
  private async consider(sig: AmbientSignal, budget?: { left: number }): Promise<void> {
    const seenKey = `${sig.sourceId}:${sig.key}`;
    if (this.store.has(seenKey) || this.queuedKeys.has(seenKey)) return; // доставлено durable ИЛИ уже в очереди процесса
    if (sig.salience < this.minSalience) {
      this.store.mark(seenKey, this.now()); // не важно — durable-помечаем, чтобы не пересматривать каждый тик
      return;
    }
    // Бюджет тика исчерпан → НИЧЕГО не помечаем и не ставим в очередь: сигнал вернётся следующим тиком
    // (иначе пачка из ящика вытеснила бы сама себя из очереди озвучки и была бы «доставлена» молча).
    if (budget && !sig.urgent && budget.left <= 0) return;
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
    const ch = this.channelFor(sig.userId);
    // §9 «не мешать» + честность (финальное ревью): владелец ЗАНЯТ (полный экран/звонок/блокировка) —
    // НЕсрочную фразу пайплайн подержит в очереди и через TTL ВЫБРОСИТ, а durable-seen уже стоял бы →
    // «через 20 минут созвон» не прозвучало бы НИ РАЗУ и больше не пересматривалось. Ждём следующий тик
    // (ровно как доклад об инцидентах не потребляется при занятом владельце).
    if (ch && !sig.urgent && ch.isBusy?.()) {
      log.info("ambient: уведомление отложено — владелец занят", { source: sig.sourceId, key: sig.key.slice(0, 40) });
      return;
    }
    // Тихие часы (волна E): та же семантика, что «занят» — несрочное не отдаём, seen не ставим,
    // сигнал вернётся тиком и прозвучит утром. Срочное (счёт с дедлайном) проходит всегда.
    // ⚠️ time-anchored сигнал (ttlMs — «через 20 минут созвон») тихие часы НЕ держат (контроль-ревью,
    // MED): к концу окна он ПРОТУХНЕТ и потеряется НАВСЕГДА («подождёт до утра» для него ложь) —
    // привязка ко времени и есть срочность по смыслу, как у напоминаний, исключённых из окна.
    if (ch && !sig.urgent && sig.ttlMs === undefined && this.inQuiet()) {
      log.info("ambient: уведомление отложено — тихие часы", { source: sig.sourceId, key: sig.key.slice(0, 40) });
      return;
    }
    if (ch) {
      // durable-seen ТОЛЬКО если очередь озвучки РЕАЛЬНО приняла реплику (контроль-7): очередь общая на
      // все проактивные каналы, и «отдал» ≠ «прозвучит». Не приняли → сигнал остаётся непомеченным и
      // вернётся следующим тиком.
      // durable-seen ТОЛЬКО по факту ОЗВУЧКИ (контроль-9): «принято в очередь» ещё не «прозвучало» —
      // TTL/стоп/смерть сессии роняют принятое, и сигнал молча считался бы доставленным.
      // Помечаем при ПРИЁМЕ, но ОТКАТЫВАЕМ, если реплика так и не прозвучала (контроль-9): очередь
      // роняет принятое по TTL, на «стоп» и на смерти сессии — без отката сигнал считался бы
      // доставленным навсегда, и владелец о нём не узнал бы.
      const ok =
        ch.speak(phrase, sig.urgent === true, (spoken) => {
          if (spoken) return;
          this.store.unmark(seenKey);
          log.info("ambient: реплика не прозвучала (очередь сбросила) — вернём следующим тиком", { key: seenKey.slice(0, 40) });
        }) !== false;
      if (!ok) {
        log.info("ambient: очередь озвучки не приняла — сигнал ждёт следующего тика", { key: seenKey.slice(0, 40) });
        return;
      }
      this.store.mark(seenKey, this.now());
      if (budget && !sig.urgent) budget.left -= 1;
      log.info("ambient: проактивное уведомление", { source: sig.sourceId, key: sig.key.slice(0, 40), urgent: sig.urgent === true });
    } else {
      this.queuedKeys.add(seenKey);
      this.pending.push({
        userId: sig.userId,
        text: phrase,
        urgent: sig.urgent === true,
        seenKey,
        ...(sig.ttlMs !== undefined ? { expiresAt: sig.ts + sig.ttlMs } : {}),
      });
      log.info("ambient: уведомление отложено (владелец офлайн)", { source: sig.sourceId, key: sig.key.slice(0, 40), urgent: sig.urgent === true });
    }
  }

  private channelFor(userId: string): { speak: (t: string, u: boolean, cb?: (spoken: boolean) => void) => unknown; isBusy?: () => boolean } | undefined {
    for (const s of this.speakers.values()) if (s.userId === userId) return s;
    return undefined;
  }

  private flushPending(userId: string): void {
    if (autonomyFreeze().isFrozen()) return; // killswitch: pending цел, отдадим после снятия стопа
    if (this.pending.length === 0) return;
    const ch = this.channelFor(userId);
    if (!ch) return;
    const now = this.now();
    let expired = false;
    // ВЫЛИВАТЬ ВСЮ ОЧЕРЕДЬ РАЗОМ НЕЛЬЗЯ (контроль-5): очередь озвучки держит лишь несколько несрочных
    // и вытесняет старейшие, а durable-seen мы ставим ЗДЕСЬ — за ночь накопленные письма были бы
    // помечены доставленными и не прозвучали бы НИКОГДА. Отдаём порцию, остальное остаётся в pending
    // и уйдёт следующими тиками (tickNow дренирует остаток).
    // ...И ТОЛЬКО КОГДА ВЛАДЕЛЕЦ СВОБОДЕН (контроль-6, HIGH — гард стоял лишь в consider()): занятому
    // владельцу пайплайн несрочное не отдаёт и через TTL выбрасывает, а seen здесь уже стоял бы →
    // потеря навсегда. Срочное (будильник/день оплаты) проходит всегда, как и в consider().
    // «Занят» держит ВСЁ несрочное (волна D — отдать занятому = пайплайн выбросит по TTL, а seen уже
    // осел бы). «Тихие часы» (волна E) держат несрочное БЕЗ временнОй привязки; запись с expiresAt
    // («через 20 минут созвон») к концу окна протухнет и потеряется навсегда — её тихие часы
    // ПРОПУСКАЮТ (контроль-ревью, MED: «подождёт до утра» для time-anchored — ложь).
    const busyHold = ch.isBusy?.() === true;
    const quietHold = this.inQuiet();
    const heldByGates = (p: { urgent: boolean; expiresAt?: number }): boolean =>
      !p.urgent && (busyHold || (quietHold && p.expiresAt === undefined));
    const busy = busyHold; // для прежних логов «владелец занят»
    const mineAll = this.pending.filter((p) => p.userId === userId);
    const fresh = mineAll.filter((p) => !(p.expiresAt !== undefined && now > p.expiresAt));
    if (fresh.length !== mineAll.length) expired = true;
    const urgent = fresh.filter((p) => p.urgent);
    const deliverableRest = fresh.filter((p) => !p.urgent && !heldByGates(p));
    const rest = deliverableRest;
    const held = [...fresh.filter((p) => !p.urgent && heldByGates(p)), ...rest.slice(FLUSH_BATCH)];
    const batch = [...urgent, ...rest.slice(0, FLUSH_BATCH)];
    const keep = new Set(held.map((p) => p.seenKey));
    if (busy && held.length > 0) log.info("ambient: очередь придержана — владелец занят", { ждут: held.length });
    // Протухшие выбрасываем (их seenKey durable НЕ помечаем — источник сформулирует заново).
    for (const p of mineAll) if (!keep.has(p.seenKey) && !batch.includes(p)) this.queuedKeys.delete(p.seenKey);
    this.pending = this.pending.filter((p) => p.userId !== userId || keep.has(p.seenKey));
    if (expired) log.info("ambient: отложенные уведомления протухли — не зачитываю (будут пересобраны)");
    if (keep.size > 0) log.info("ambient: очередь отдана порцией, остаток ждёт", { остаток: keep.size });
    for (const p of batch) {
      // Приняла ли очередь озвучки — решает она (контроль-7). Не приняла → возвращаем в pending.
      const ok =
        ch.speak(p.text, p.urgent, (spoken) => {
          if (spoken) return;
          // Не прозвучала → откатываем пометку и возвращаем в ожидание (контроль-9).
          this.store.unmark(p.seenKey);
          this.queuedKeys.add(p.seenKey);
          this.pending.push(p);
          log.info("ambient: отложенная реплика не прозвучала — вернулась в ожидание", { key: p.seenKey.slice(0, 40) });
        }) !== false;
      if (!ok) {
        this.pending.push(p);
        continue;
      }
      this.store.mark(p.seenKey, this.now()); // отдано в канал → durable seen (откат в колбэке)
      this.queuedKeys.delete(p.seenKey);
    }
    // Что-то выбросили как протухшее → СРАЗУ пере-опрашиваем источники: событие могло остаться
    // актуальным, и владелец должен услышать его со СВЕЖЕЙ формулировкой, а не ждать целый тик.
    if (expired) void this.tickNow();
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
