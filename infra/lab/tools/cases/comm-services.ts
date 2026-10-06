/**
 * Серверные сервисы времени (напоминания / наблюдения / обязательства) с записями ДРУГОГО владельца — для кейсов
 * изоляции: «чужое не видно, не снимается, не считается в моём лимите». Хранилище — каталог текущей лаборатории
 * (JARVIS_DATA_DIR, его ставит изоляция ДО вычисления геттера), поэтому боевые данные не задеты. Записи с фиксированными
 * id — чтобы кейс мог целиться в чужой id (полный обход по id — самый простой способ снять чужое).
 */
import type { ToolContext } from "../../../../apps/server/src/brain/tools/dispatch.js";
import { type Obligation, ObligationStore } from "../../../../apps/server/src/proactive/ambient/obligations.js";
import { ReminderService } from "../../../../apps/server/src/proactive/reminders/service.js";
import { ReminderStore } from "../../../../apps/server/src/proactive/reminders/store.js";
import { WatchService } from "../../../../apps/server/src/proactive/watch/service.js";
import { WatchStore } from "../../../../apps/server/src/proactive/watch/store.js";

export const OTHER_OWNER = "comm-other-owner";
const DAY = 86_400_000;
const dir = (): string => process.env.JARVIS_DATA_DIR ?? "";
const blindChecker = async () => ({ met: false, summary: "", error: "лаборатория: проверка не подключена", transient: true });

export interface ForeignOwner {
  reminders?: Array<{ id: string; text: string }>;
  watches?: Array<{ id: string; what: string; condition: string }>;
  obligations?: Array<{ id: string; what: string }>;
}

/** ctx-геттеры: свои сервисы лаборатории заменяются такими же, но с записями чужого владельца. */
export function foreignOwner(f: ForeignOwner): Partial<ToolContext> {
  const out: Partial<ToolContext> = {};
  const now = Date.now();
  const base = { userId: OTHER_OWNER, sessionId: "other-session", createdAt: now };
  if (f.reminders) {
    Object.defineProperty(out, "reminders", {
      enumerable: true,
      get() {
        const store = new ReminderStore(dir());
        for (const r of f.reminders!) store.add({ ...base, id: r.id, text: r.text, fireAt: now + 30 * DAY, status: "scheduled" });
        return new ReminderService(store);
      },
    });
  }
  if (f.watches) {
    Object.defineProperty(out, "watch", {
      enumerable: true,
      get() {
        const store = new WatchStore(dir());
        for (const w of f.watches!) store.add({ ...base, id: w.id, what: w.what, condition: w.condition, intervalMs: 300_000, continuous: false, status: "active" });
        return new WatchService(blindChecker, store);
      },
    });
  }
  if (f.obligations) {
    Object.defineProperty(out, "obligations", {
      enumerable: true,
      get() {
        const store = new ObligationStore(dir());
        for (const o of f.obligations!) store.add({ ...base, id: o.id, what: o.what, dueAt: now + 30 * DAY } as Obligation);
        return store;
      },
    });
  }
  return out;
}
