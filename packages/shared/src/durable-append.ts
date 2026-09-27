/**
 * C4/B5 аудита прод-логов 27.09: запись порции durable-лога с политикой на сбой ФС. Раньше flush() забирал
 * буфер ДО appendFileSync и глотал ошибку: 26.09 файл дня ~10,7 ч не принимал запись (причина внешняя, по логам
 * не установлена), и строки терялись МОЛЧА до смены имени файла в полночь. Теперь:
 *  - сбой → порция не теряется, а откладывается (потолок maxPending; сверх него старые выкидываем и СЧИТАЕМ);
 *  - первый сбой — одно предупреждение с кодом ошибки; дальше напоминание не чаще warnEveryMs, со счётчиками;
 *  - fallbackAfter сбоев подряд → пишем в запасной файл (`<день>.<pid>.log`), предупредив о переходе один раз;
 *  - каждый флаш сначала пробует основной: ожил → отложенное ложится туда по порядку + сводка инцидента.
 * Отложенное живёт ЗДЕСЬ, а не в буфере sink: иначе его страж «≥ 2000 строк → флаш» дёргал бы сбойную запись на
 * каждую новую строку. Предупреждения идут в логгер (консоль + этот же sink): буфер sink к этому моменту пуст —
 * вложенного флаша нет, а сама строка ляжет в файл следующим флашем.
 * ОДИН модуль для клиента и сервера (DRY): subpath `@jarvis/shared/durable-append`, НЕ из index — браузерные бандлы
 * (renderer, расширение) shared тоже тянут, а здесь node:fs.
 */
import { appendFileSync } from "node:fs";
import type { Logger } from "./index.js";

export interface DurableAppendOpts {
  /** Сколько сбоев основного файла подряд до перехода на запасной. */
  fallbackAfter?: number;
  /** Потолок отложенных строк (когда не пишется ни основной, ни запасной). */
  maxPending?: number;
  /** Напоминание о продолжающемся сбое — не чаще. */
  warnEveryMs?: number;
  now?: () => number;
}

/** Ошибка записи или null, если строки легли. */
function tryAppend(file: string, data: string): NodeJS.ErrnoException | null {
  try {
    appendFileSync(file, data);
    return null;
  } catch (e) {
    return e instanceof Error ? (e as NodeJS.ErrnoException) : new Error(String(e));
  }
}

export class DurableAppender {
  private pending: string[] = [];
  private failures = 0; // сбоев основного подряд
  private lost = 0; // выкинуто сверх потолка за инцидент
  private viaFallback = 0; // строк ушло в запасной за инцидент
  private fallbackFile: string | null = null;
  private fallbackBroken = false;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private readonly fallbackAfter: number;
  private readonly maxPending: number;
  private readonly warnEveryMs: number;
  private readonly now: () => number;

  constructor(
    private readonly log: Pick<Logger, "warn" | "info">,
    opts: DurableAppendOpts = {},
  ) {
    this.fallbackAfter = opts.fallbackAfter ?? 3;
    this.maxPending = opts.maxPending ?? 5000;
    this.warnEveryMs = opts.warnEveryMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Нечего дописывать: flush с пустым буфером может выйти (иначе обязан повторить отложенное). */
  get idle(): boolean {
    return this.pending.length === 0;
  }

  /** Дописать отложенное + lines в основной файл; при сбое — отложить или (после N подряд) в запасной. */
  write(primary: string, fallback: string, lines: string[]): void {
    const batch = this.pending.length > 0 ? this.pending.concat(lines) : lines;
    if (batch.length === 0) return;
    const data = `${batch.join("\n")}\n`;
    const err = tryAppend(primary, data);
    if (!err) {
      this.pending = [];
      if (this.failures > 0) this.recovered(primary);
      return;
    }
    this.failures++;
    const code = err.code ?? "unknown";
    if (this.failures === 1) this.warn("durable-лог: запись в файл не удалась — строки держу в памяти", { code, file: primary, error: err.message });
    if (this.failures >= this.fallbackAfter && this.toFallback(fallback, data, batch.length, code)) return;
    this.keep(batch);
    this.remind(code);
  }

  /** Запасной файл: true — строки легли. О переходе и о поломке запасного — по одному предупреждению. */
  private toFallback(fallback: string, data: string, count: number, code: string): boolean {
    const err = tryAppend(fallback, data);
    if (err) {
      if (!this.fallbackBroken) this.warn("durable-лог: запасной файл тоже не пишется", { code: err.code ?? "unknown", file: fallback, primaryCode: code });
      this.fallbackBroken = true;
      return false;
    }
    this.pending = [];
    this.viaFallback += count;
    if (this.fallbackFile !== fallback) {
      this.fallbackFile = fallback;
      this.warn("durable-лог: основной файл недоступен — пишу в запасной", { file: fallback, code, failures: this.failures });
    } else this.remind(code);
    return true;
  }

  /** Отложить с потолком: при переполнении выкидываем самые старые и считаем потерю. */
  private keep(batch: string[]): void {
    const over = batch.length - this.maxPending;
    if (over > 0) this.lost += over;
    this.pending = over > 0 ? batch.slice(over) : batch;
  }

  /** Сбой продолжается — напомнить не чаще warnEveryMs, со счётчиками. */
  private remind(code: string): void {
    if (this.now() - this.lastWarnAt < this.warnEveryMs) return;
    this.warn("durable-лог: основной файл всё ещё недоступен", {
      code,
      failures: this.failures,
      pending: this.pending.length,
      lost: this.lost,
      viaFallback: this.viaFallback,
      ...(this.fallbackFile ? { fallback: this.fallbackFile } : {}),
    });
  }

  /** Основной ожил: сводка инцидента и сброс счётчиков. */
  private recovered(primary: string): void {
    this.log.info("durable-лог: основной файл снова пишется", {
      file: primary,
      failures: this.failures,
      lost: this.lost,
      viaFallback: this.viaFallback,
      ...(this.fallbackFile ? { fallback: this.fallbackFile } : {}),
    });
    this.failures = 0;
    this.lost = 0;
    this.viaFallback = 0;
    this.fallbackFile = null;
    this.fallbackBroken = false;
    this.lastWarnAt = Number.NEGATIVE_INFINITY;
  }

  private warn(msg: string, meta: Record<string, unknown>): void {
    this.lastWarnAt = this.now();
    this.log.warn(msg, meta);
  }
}
