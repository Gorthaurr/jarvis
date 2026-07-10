/**
 * Источник ambient #1: ОБЯЗАТЕЛЬСТВА/СЧЕТА (§проактив-всё, пример «не забудьте оплатить счета»). Durable-список
 * дат-обязательств (разовых или ежемесячных) → чистая дата-математика (БЕЗ LLM) → проактивное предупреждение
 * заранее и в день оплаты. Владелец добавляет через инструмент obligation_add; источник опрашивается движком.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir as defaultDataDir } from "../../paths.js";
import type { AmbientSignal, AmbientSource } from "./signal.js";

const log: Logger = createLogger("ambient:obligations");

export interface Obligation {
  id: string;
  userId: string;
  /** Что оплатить/сделать, на естественном языке («счёт за свет», «аренда»). */
  what: string;
  /** Сумма (опц., для фразы). */
  amount?: string;
  /** Абсолютный срок (разовое). Взаимоисключимо с recurringDay. */
  dueAt?: number;
  /** День месяца (1..31) для ЕЖЕМЕСЯЧНЫХ обязательств (счета каждый месяц). */
  recurringDay?: number;
  createdAt: number;
}

const DAY = 24 * 3600_000;

/** YYYY-MM-DD (локальная дата) — для ключа дедупа на одно «срабатывание». */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Ближайший срок обязательства (для ежемесячного — следующее наступление дня месяца). Чистая функция. */
export function upcomingDue(o: Obligation, now: number): number | null {
  if (o.dueAt !== undefined) return o.dueAt;
  if (o.recurringDay !== undefined) {
    const d = new Date(now);
    const day = Math.min(Math.max(1, Math.floor(o.recurringDay)), 28); // 28 — безопасно для всех месяцев
    let due = new Date(d.getFullYear(), d.getMonth(), day, 12, 0, 0).getTime();
    if (due < now - 12 * 3600_000) due = new Date(d.getFullYear(), d.getMonth() + 1, day, 12, 0, 0).getTime();
    return due;
  }
  return null;
}

/** Durable-стор обязательств: JSON data/obligations.json, атомарно. */
export class ObligationStore {
  private items: Obligation[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly dir: string;

  constructor(dataDir = defaultDataDir()) {
    this.dir = dataDir;
    this.path = join(dataDir, "obligations.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Obligation[];
      this.items = Array.isArray(parsed) ? parsed : [];
      log.info("обязательства загружены", { count: this.items.length });
    } catch {
      this.items = [];
    }
  }

  list(userId?: string): Obligation[] {
    return this.items.filter((o) => !userId || o.userId === userId);
  }

  add(o: Obligation): void {
    this.items.push(o);
    this.persist();
  }

  /** Удалить разовое прошедшее обязательство (гигиена) — ежемесячные не трогаем. */
  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((o) => o.id !== id);
    if (this.items.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  /** Снять по id или по фрагменту `what` (для obligation_remove «убери счёт за свет»). */
  cancel(idOrQuery: string, userId?: string): Obligation | null {
    const byId = this.items.find((o) => o.id === idOrQuery);
    let target = byId;
    if (!target) {
      const q = idOrQuery.toLowerCase().trim();
      target = this.list(userId).filter((o) => o.what.toLowerCase().includes(q)).pop();
    }
    if (!target) return null;
    this.remove(target.id);
    return target;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.items, null, 2);
    this.writeChain = this.writeChain.then(() => this.doPersist(snapshot));
  }

  private async doPersist(snapshot: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.path);
    } catch (e) {
      log.warn("не удалось сохранить обязательства", e instanceof Error ? e.message : String(e));
    }
  }
}

export interface ObligationsSourceOpts {
  now?: () => number;
  enabled?: () => boolean;
  /** За сколько ДО срока начинать предупреждать (мс). Деф 2 дня (env JARVIS_OBLIGATION_WARN_DAYS). */
  warnMs?: number;
}

/** Чистая функция: какой сигнал (если есть) выдать по обязательству сейчас. Двухстадийно: «скоро» и «сегодня». */
export function obligationSignal(o: Obligation, now: number, warnMs: number): AmbientSignal | null {
  const due = upcomingDue(o, now);
  if (due === null) return null;
  const left = due - now;
  if (left > warnMs) return null; // ещё рано предупреждать
  if (left < -2 * DAY) return null; // сильно просрочено (не долбим вечно; повтор по ежемесячному придёт в след. цикле)
  const amount = o.amount ? ` (${o.amount})` : "";
  const dueStage = left <= DAY; // сегодня/завтра/просрочено → срочный «день оплаты»
  const stage = dueStage ? "due" : "soon";
  const when = left <= 0 ? "сегодня" : left <= DAY ? "завтра" : `через ${Math.round(left / DAY)} дн.`;
  return {
    sourceId: "obligations",
    userId: o.userId,
    key: `${o.id}:${dayKey(due)}:${stage}`,
    title: `Сэр, ${dueStage ? "напоминаю: сегодня" : "скоро (" + when + ")"} оплатить — ${o.what}${amount}.`,
    detail: `срок ${dayKey(due)}`,
    salience: dueStage ? 0.95 : 0.6,
    urgent: dueStage, // в день оплаты — пройдёт даже при занятости
    ts: now,
  };
}

/** Собрать ambient-источник обязательств поверх стора. */
export function createObligationsSource(store: ObligationStore, opts: ObligationsSourceOpts = {}): AmbientSource {
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled ?? (() => true);
  const warnMs = opts.warnMs ?? warnMsFromEnv();
  return {
    id: "obligations",
    label: "Счета и обязательства",
    enabled,
    poll: async () => {
      const t = now();
      const out: AmbientSignal[] = [];
      for (const o of store.list()) {
        const s = obligationSignal(o, t, warnMs);
        if (s) out.push(s);
      }
      return out;
    },
  };
}

function warnMsFromEnv(): number {
  const n = Number.parseInt(process.env.JARVIS_OBLIGATION_WARN_DAYS ?? "", 10);
  return (Number.isFinite(n) && n > 0 ? n : 2) * DAY;
}

/** Создать обязательство из инструмента (валидация + нормализация). null → некорректно. */
export function makeObligation(input: {
  userId: string;
  what: string;
  amount?: string;
  dueAt?: number;
  recurringDay?: number;
  now: number;
}): Obligation | null {
  const what = input.what.trim();
  if (!what) return null;
  if (input.dueAt === undefined && input.recurringDay === undefined) return null;
  return {
    id: newId(),
    userId: input.userId,
    what,
    ...(input.amount ? { amount: input.amount.trim() } : {}),
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    ...(input.recurringDay !== undefined ? { recurringDay: input.recurringDay } : {}),
    createdAt: input.now,
  };
}
