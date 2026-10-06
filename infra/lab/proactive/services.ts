/**
 * Сборка НАСТОЯЩИХ сервисов проактива на каталоге прогона (те же классы и сторы, что в бою; из подмен - только
 * проверяльщик наблюдения и лабораторный ambient-источник). Часы - `Date.now` (виртуальный, см. clock.ts).
 */
import "../tools/isolation.js"; // ПЕРВЫМ: сторы без явного каталога иначе полезли бы в данные владельца
import { AmbientEngine } from "../../../apps/server/src/proactive/ambient/engine.js";
import { ObligationStore, createObligationsSource } from "../../../apps/server/src/proactive/ambient/obligations.js";
import type { AmbientSignal, AmbientSource } from "../../../apps/server/src/proactive/ambient/signal.js";
import { AmbientSeenStore } from "../../../apps/server/src/proactive/ambient/store.js";
import { ReminderService } from "../../../apps/server/src/proactive/reminders/service.js";
import { ReminderStore } from "../../../apps/server/src/proactive/reminders/store.js";
import { WatchService } from "../../../apps/server/src/proactive/watch/service.js";
import { WatchStore } from "../../../apps/server/src/proactive/watch/store.js";
import type { WatchChecker } from "../../../apps/server/src/proactive/watch/watch.js";

export interface LabOptions {
  /** Локальный старт ("2026-07-29T08:00:00") - в поясе `tz`. */
  start?: string;
  tz?: string;
  quietHours?: string;
  ambientIntervalMs?: number;
  minSalience?: number;
  graceMs?: number;
  watchMinIntervalMs?: number;
  maxFailures?: number;
  /** Часовой предохранитель автономных LLM-вызовов; 0 = выключен (деф стенда). */
  llmPerHour?: number;
  /** Настоящие ambient-источники поверх фейковых ридеров вкладок (календарь/Telegram/почта); живут между рестартами стенда. */
  extraSources?: AmbientSource[];
}

/** Что сценарий подсовывает сервисам: вердикт проверяльщика и текущие ambient-сигналы (poll отдаёт ВСЕ, дедуп - дело движка). */
export interface Script {
  checker: WatchChecker;
  signals: AmbientSignal[];
}

export const newScript = (): Script => ({
  checker: async () => ({ met: false, summary: "", error: "lab: проверяльщик не задан", transient: true }),
  signals: [],
});

export interface Services {
  reminders: ReminderService;
  watch: WatchService;
  ambient: AmbientEngine;
  obligations: ObligationStore;
  stores: { flush(): Promise<void> }[];
}

const now = (): number => Date.now();

export function buildServices(dir: string, o: LabOptions, script: Script): Services {
  const reminderStore = new ReminderStore(dir);
  const watchStore = new WatchStore(dir);
  const seen = new AmbientSeenStore(dir);
  const obligations = new ObligationStore(dir);
  const reminders = new ReminderService(reminderStore, { now, ...(o.graceMs !== undefined ? { graceMs: o.graceMs } : {}) });
  const watch = new WatchService((w) => script.checker(w), watchStore, {
    now,
    minIntervalMs: o.watchMinIntervalMs ?? 1_000,
    ...(o.maxFailures !== undefined ? { maxFailures: o.maxFailures } : {}),
  });
  const labSource: AmbientSource = { id: "lab", label: "lab", enabled: () => true, poll: async () => [...script.signals] };
  const ambient = new AmbientEngine([createObligationsSource(obligations, { now }), labSource, ...(o.extraSources ?? [])], seen, {
    now,
    intervalMs: o.ambientIntervalMs ?? 90_000,
    quietHours: o.quietHours ?? "", // "" = выкл и НЕ читать JARVIS_QUIET_HOURS владельца
    ...(o.minSalience !== undefined ? { minSalience: o.minSalience } : {}),
  });
  return { reminders, watch, ambient, obligations, stores: [reminderStore, watchStore, seen, obligations] };
}

/** Порядок старта - как в gateway/server.ts:577-607. */
export async function startServices(s: Services): Promise<void> {
  await s.reminders.start();
  await s.watch.start();
  await s.obligations.load();
  await s.ambient.start();
}

/** Порядок остановки - как в gateway close(): таймеры, затем дозапись сторов. */
export async function stopServices(s: Services): Promise<void> {
  s.reminders.stop();
  s.watch.stop();
  s.ambient.stop();
  await Promise.all(s.stores.map((x) => x.flush()));
}
