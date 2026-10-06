/**
 * Общие приёмы тестов проактива: регистрация стенда в beforeEach/afterEach и короткие постановщики дел.
 * sessionId дел намеренно НЕ совпадает с сессией владельца ("s0"): доставка обязана идти по userId (переподключение).
 */
import { afterEach, beforeEach } from "vitest";
import { autonomyFreeze } from "../../../apps/server/src/autonomy/freeze.js";
import type { Reminder, RepeatRule } from "../../../apps/server/src/proactive/reminders/reminder.js";
import type { Watch } from "../../../apps/server/src/proactive/watch/watch.js";
import { type LabOptions, type ProactiveLab, createProactiveLab } from "./lab.js";

export const OWNER = "owner";

/** Стенд на каждый тест: `const t = useLab(); it(..., () => { const lab = t.lab; ... })`. */
export function useLab(opts: LabOptions & { boot?: boolean } = {}): { readonly lab: ProactiveLab } {
  let current: ProactiveLab | undefined;
  beforeEach(async () => {
    current = await createProactiveLab(opts);
  });
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  return {
    get lab(): ProactiveLab {
      if (!current) throw new Error("стенд ещё не создан (beforeEach)");
      return current;
    },
  };
}

/** Поставить напоминание через `ms` от «сейчас». Возвращает запись с fireAt (мс). */
export function remind(lab: ProactiveLab, text: string, inMs: number, repeat?: RepeatRule): Reminder {
  return lab.svc.reminders.add({ sessionId: "s0", userId: OWNER, text, fireAt: lab.clock.now() + inMs, ...(repeat ? { repeat } : {}) });
}

/** Поставить напоминание на локальный момент ("2026-07-29T09:00:00"). */
export function remindAt(lab: ProactiveLab, text: string, local: string, repeat?: RepeatRule): Reminder {
  return lab.svc.reminders.add({ sessionId: "s0", userId: OWNER, text, fireAt: lab.clock.at(local), ...(repeat ? { repeat } : {}) });
}

export interface WatchSpec {
  what?: string;
  condition?: string;
  intervalMs?: number;
  continuous?: boolean;
  action?: string;
  predicate?: unknown;
}

/** Поставить наблюдение владельца; провал постановки - исключение (тест не должен молча идти дальше). */
export function watch(lab: ProactiveLab, s: WatchSpec = {}): Watch {
  const r = lab.svc.watch.add({
    sessionId: "s0",
    userId: OWNER,
    what: s.what ?? "курс биткоина",
    condition: s.condition ?? "ниже 60000",
    intervalMs: s.intervalMs ?? 60_000,
    ...(s.continuous !== undefined ? { continuous: s.continuous } : {}),
    ...(s.action ? { action: s.action } : {}),
    ...(s.predicate ? { predicate: s.predicate } : {}),
  });
  if (!r.ok) throw new Error(`watch.add отказал: ${r.reason}`);
  return r.watch;
}

/** Виртуальные времена относительно момента `t0` в секундах - читается лучше, чем мс в ожиданиях. */
export const secs = (list: number[], t0: number): number[] => list.map((t) => (t - t0) / 1000);

/** «Полный стоп» владельца - ровно шаги gateway/task-control.ts:94-111: латч на диск (напоминания НЕ трогает). */
export function autonomyStop(): boolean {
  return autonomyFreeze().freeze("команда владельца (лаборатория)");
}

/** «Включи автономию» - task-control.ts:127-131: латч снят + пинок watch-тика (замороженный таймер не ждёт 30 с). */
export function autonomyResume(lab: ProactiveLab): boolean {
  const clean = autonomyFreeze().unfreeze();
  void lab.svc.watch.tickNow();
  return clean;
}
