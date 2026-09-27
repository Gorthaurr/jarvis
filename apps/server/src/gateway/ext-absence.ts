/**
 * УЧЁТ ОТСУТСТВИЯ РАСШИРЕНИЯ (живой факт 27.09): распакованное «Jarvis Web Hands» пропало из Chrome владельца
 * 24.09 (папку переименовали — Chrome помнит путь), браузерные инструменты честно отвечали «не подключено»,
 * но САМ владелец трое суток не знал, что рук в браузере нет. Здесь — только учёт; доклад — ext-absence-report.ts.
 *
 * Два сигнала из двух источников (не смешивать):
 *  • `lastSeenAt` — СОБЫТИЯМИ моста (attach/detach, `trackExtPresence` в ext-absence-seam.ts): «на связи до …» честно и тогда,
 *    когда клиент лежал; плюс тик с живым флагом `connected`.
 *  • счётчики отсутствия — ТИКАМИ `client.context` (клиент шлёт раз в 15 с): считается только НАБЛЮДЁННОЕ
 *    время (разрыв тиков > MAX_TICK_GAP — ПК/сервер/клиент были выключены — не в счёт). `chromeMs` — сколько
 *    из него Chrome был на переднем плане: Chrome запущен, а расширение (подключается при старте Chrome и
 *    по будильнику SW ~24 с) так и не пришло — это уже не «Chrome закрыт».
 * Любое подключение гасит счётчики и флаг доклада: «один раз до восстановления». Состояние durable.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { lazyDataPath } from "../paths.js";

/** Уверенный доклад: наблюдали ≥ 2 ч без расширения, из них Chrome на переднем плане ≥ 10 мин. */
export const STRONG_ABSENT_MS = 2 * 3_600_000;
export const CHROME_EVIDENCE_MS = 10 * 60_000;
/** Мягкий доклад («если Chrome открыт…»): ≥ 12 ч наблюдённого отсутствия без признаков Chrome. */
export const SOFT_ABSENT_MS = 12 * 3_600_000;
/** Больше этого между тиками — простой (ПК спал, клиент/сервер лежали), в счёт идёт только этот кусок. */
export const MAX_TICK_GAP_MS = 45_000;
const SAVE_EVERY_MS = 60_000;

interface State {
  lastSeenAt: number | null;
  absentMs: number;
  chromeMs: number;
  reportedAt: number | null;
}

/** Что пора сказать: `chrome` — Chrome точно был открыт; `unknown` — мягко, Chrome мог быть закрыт. */
export interface ExtAbsenceDue {
  kind: "chrome" | "unknown";
  lastSeenAt: number | null;
  absentMs: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const fresh = (): State => ({ lastSeenAt: null, absentMs: 0, chromeMs: 0, reportedAt: null });

/** Процесс переднего окна — Chrome? (`client.context.activeApp` = ProcessName: «chrome», без .exe.) */
export function isChromeProcess(app: string | undefined): boolean {
  return (app ?? "").trim().toLowerCase().replace(/\.exe$/, "") === "chrome";
}

export class ExtAbsence {
  private state: State;
  private lastTickAt: number | null = null;
  private lastSaveAt = 0;

  constructor(
    private readonly file: () => string = lazyDataPath("ext-presence.json"),
    private readonly clock: () => number = Date.now,
    private readonly log: Logger = createLogger("ext-absence"),
  ) {
    this.state = this.load();
  }

  /** Событие моста (attach/detach): состояние ПОСЛЕ события. */
  noteBridge(connected: boolean): void {
    if (connected) this.restore();
    else {
      this.state.lastSeenAt = this.clock();
      this.save();
    }
  }

  /** Тик `client.context`: копим наблюдённое отсутствие (и Chrome на переднем плане), либо фиксируем связь. */
  tick(activeApp: string | undefined, connected: boolean): void {
    const now = this.clock();
    const delta = this.lastTickAt === null ? 0 : Math.min(Math.max(0, now - this.lastTickAt), MAX_TICK_GAP_MS);
    this.lastTickAt = now;
    if (connected) return this.restore();
    this.state.absentMs += delta;
    if (isChromeProcess(activeApp)) this.state.chromeMs += delta;
    if (now - this.lastSaveAt >= SAVE_EVERY_MS) this.save();
  }

  /** Пора ли докладывать (null — нет: на связи, мало данных или в этом провале уже сказали). */
  due(connected: boolean): ExtAbsenceDue | null {
    const s = this.state;
    if (connected || s.reportedAt !== null) return null;
    const chrome = s.chromeMs >= CHROME_EVIDENCE_MS;
    if (chrome ? s.absentMs < STRONG_ABSENT_MS : s.absentMs < SOFT_ABSENT_MS) return null;
    return { kind: chrome ? "chrome" : "unknown", lastSeenAt: s.lastSeenAt, absentMs: s.absentMs };
  }

  /** Владельцу сказано — молчим до восстановления связи. */
  markReported(): void {
    this.state.reportedAt = this.clock();
    this.save();
  }

  private restore(): void {
    const s = this.state;
    const wasReported = s.reportedAt !== null;
    const changed = wasReported || s.absentMs > 0 || s.chromeMs > 0;
    const now = this.clock();
    this.state = { lastSeenAt: now, absentMs: 0, chromeMs: 0, reportedAt: null };
    if (wasReported) this.log.info("расширение снова на связи — доклад об отсутствии погашен");
    if (changed || now - this.lastSaveAt >= SAVE_EVERY_MS) this.save();
  }

  private load(): State {
    try {
      const raw = JSON.parse(readFileSync(this.file(), "utf8")) as Record<string, unknown>;
      return {
        lastSeenAt: num(raw.lastSeenAt),
        absentMs: num(raw.absentMs) ?? 0,
        chromeMs: num(raw.chromeMs) ?? 0,
        reportedAt: num(raw.reportedAt),
      };
    } catch {
      return fresh(); // нет файла / битый — начинаем учёт заново (fail-safe)
    }
  }

  private save(): void {
    this.lastSaveAt = this.clock();
    try {
      const file = this.file();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ v: 1, ...this.state }), "utf8");
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
