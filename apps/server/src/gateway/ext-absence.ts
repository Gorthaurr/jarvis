/**
 * УЧЁТ ОТСУТСТВИЯ РАСШИРЕНИЯ (живой факт 27.09): распакованное «Jarvis Web Hands» пропало из Chrome владельца
 * 24.09 (папку переименовали — Chrome помнит путь), браузерные инструменты честно отвечали «не подключено»,
 * но САМ владелец трое суток не знал, что рук в браузере нет. Здесь — логика учёта; хранение — ext-absence-store.ts,
 * доклад — ext-absence-report.ts, швы — ext-absence-seam.ts.
 *
 * Сигналы (не смешивать источники):
 *  • `lastSeenAt` — СОБЫТИЯМИ моста (attach/detach): «на связи до …» честно и тогда, когда клиент лежал;
 *  • счётчики — ТИКАМИ `client.context` (раз в 15 с): только НАБЛЮДЁННОЕ время — разрыв > MAX_TICK_GAP (ПК спал,
 *    лежал клиент/сервер) и заблокированный экран (ночь с включённым ПК) не в счёт; `chromeMs` — сколько из него
 *    Chrome был на переднем плане (расширение подключается при старте Chrome и по будильнику SW ~24 с);
 *  • `pinRejectedId` — наше расширение стучалось, но /ext отклонил его по ID: Chrome точно открыт, лечение другое.
 * Доклад — раз до восстановления связи; мягкий («Chrome мог быть закрыт») может ОДИН раз эскалировать до уверенного,
 * когда появятся улики Chrome (иначе мягкий съедал бы флаг, и провал снова оставался немым — ревью 27.09, HIGH).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { lazyDataPath } from "../paths.js";
import { type AbsenceKind, type AbsenceState, freshAbsence, loadAbsence, saveAbsence } from "./ext-absence-store.js";

/** Уверенный доклад: наблюдали ≥ 2 ч без расширения, из них Chrome на переднем плане ≥ 10 мин. */
export const STRONG_ABSENT_MS = 2 * 3_600_000;
export const CHROME_EVIDENCE_MS = 10 * 60_000;
/** Мягкий доклад («если Chrome открыт…»): ≥ 12 ч наблюдённого отсутствия без признаков Chrome. */
export const SOFT_ABSENT_MS = 12 * 3_600_000;
/** Больше этого между тиками — простой (ПК спал, клиент/сервер лежали), в счёт идёт только этот кусок. */
export const MAX_TICK_GAP_MS = 45_000;
const SAVE_EVERY_MS = 60_000;

/** Что пора сказать: `chrome` — Chrome точно работал; `unknown` — мягко, Chrome мог быть закрыт. */
export interface ExtAbsenceDue {
  kind: AbsenceKind;
  lastSeenAt: number | null;
  absentMs: number;
  chromeMs: number;
  pinRejectedId: string | null;
}

/** Процесс переднего окна — Chrome? (`client.context.activeApp` = ProcessName: «chrome», без .exe.) */
export function isChromeProcess(app: unknown): boolean {
  return typeof app === "string" && app.trim().toLowerCase().replace(/\.exe$/, "") === "chrome";
}

export class ExtAbsence {
  private state: AbsenceState;
  private lastTickAt: number | null = null;
  private lastSaveAt = 0;

  constructor(
    private readonly file: () => string = lazyDataPath("ext-presence.json"),
    private readonly clock: () => number = Date.now,
    private readonly log: Logger = createLogger("ext-absence"),
  ) {
    this.state = loadAbsence(this.file(), this.clock());
  }

  /** Событие моста (attach/detach): состояние ПОСЛЕ события. */
  noteBridge(connected: boolean): void {
    if (connected) return this.restore();
    this.state.lastSeenAt = this.clock();
    this.save();
  }

  /** /ext отклонил расширение по ID, пока нашего нет на связи. */
  notePinRejected(extId: string): void {
    if (this.state.pinRejectedId === extId) return;
    this.state.pinRejectedId = extId;
    this.save();
  }

  /** Тик `client.context`: копим наблюдённое отсутствие (и Chrome на переднем плане), либо фиксируем связь. */
  tick(activeApp: unknown, connected: boolean, locked = false): void {
    const now = this.clock();
    const delta = this.lastTickAt === null ? 0 : Math.min(Math.max(0, now - this.lastTickAt), MAX_TICK_GAP_MS);
    this.lastTickAt = now;
    if (connected) return this.restore();
    if (locked) return; // владельца за экраном нет — это не наблюдение
    this.state.absentMs += delta;
    if (isChromeProcess(activeApp)) this.state.chromeMs += delta;
    if (this.saveDue(now)) this.save();
  }

  /** Пора ли докладывать (null — нет: на связи, мало данных или этот вид доклада уже был). */
  due(connected: boolean): ExtAbsenceDue | null {
    const s = this.state;
    if (connected || s.reportedKind === "chrome") return null;
    const kind: AbsenceKind = s.chromeMs >= CHROME_EVIDENCE_MS || s.pinRejectedId !== null ? "chrome" : "unknown";
    if (s.reportedKind === kind) return null; // мягкий уже был и улик Chrome не прибавилось
    if (s.absentMs < (kind === "chrome" ? STRONG_ABSENT_MS : SOFT_ABSENT_MS)) return null;
    return { kind, lastSeenAt: s.lastSeenAt, absentMs: s.absentMs, chromeMs: s.chromeMs, pinRejectedId: s.pinRejectedId };
  }

  /** Владельцу сказано — этот вид доклада молчит до восстановления связи. */
  markReported(kind: AbsenceKind): void {
    this.state.reportedKind = kind;
    this.save();
  }

  private restore(): void {
    const s = this.state;
    const changed = s.reportedKind !== null || s.absentMs > 0 || s.chromeMs > 0 || s.pinRejectedId !== null;
    if (s.reportedKind !== null) this.log.info("расширение снова на связи — доклад об отсутствии погашен");
    const now = this.clock();
    this.state = { ...freshAbsence(), lastSeenAt: now };
    if (changed || this.saveDue(now)) this.save();
  }

  /** Троттлинг записи; часы ушли назад (NTP) — пишем сразу, а не через «минус час» ожидания. */
  private saveDue(now: number): boolean {
    return now - this.lastSaveAt >= SAVE_EVERY_MS || now < this.lastSaveAt;
  }

  private save(): void {
    this.lastSaveAt = this.clock();
    try {
      saveAbsence(this.file(), this.state);
    } catch (e) {
      this.log.warn("учёт расширения не сохранился", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

let singleton: ExtAbsence | undefined;
/** Ленивый синглтон (путь стора читается при первом зове — после загрузки .env). */
export function extAbsence(): ExtAbsence {
  if (!singleton) singleton = new ExtAbsence();
  return singleton;
}
/** Тестам: подменить/сбросить синглтон (изолированный файл, фейковые часы). */
export function setExtAbsenceForTests(t: ExtAbsence | undefined): void {
  singleton = t;
}
