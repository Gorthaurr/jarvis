/**
 * Серверные сервисы ToolContext для лаборатории: те же классы, что в бою, но с ХРАНИЛИЩЕМ в каталоге прогона,
 * без таймеров запуска (start() не зовём), без LLM/сети. Всё, чего здесь нет, честно отсутствует в ctx —
 * хендлер ответит «не сконфигурировано», а limits.ts пометит инструмент как «не проверяется в лаборатории».
 */
import { TOOLS_BY_NAME } from "../../../packages/tools/src/index.js";
import type { HostLookup } from "../../../packages/shared/src/index.js";
import { HashEmbeddingProvider } from "../../../apps/server/src/integrations/openai-embeddings.js";
import { InMemoryEpisodicMemory } from "../../../apps/server/src/memory/episodic.js";
import { DynamicToolStore } from "../../../apps/server/src/brain/tools/dynamic.js";
import { ReminderService } from "../../../apps/server/src/proactive/reminders/service.js";
import { ReminderStore } from "../../../apps/server/src/proactive/reminders/store.js";
import { WatchService } from "../../../apps/server/src/proactive/watch/service.js";
import { WatchStore } from "../../../apps/server/src/proactive/watch/store.js";
import { ObligationStore } from "../../../apps/server/src/proactive/ambient/obligations.js";
import type { ToolContext } from "../../../apps/server/src/brain/tools/dispatch.js";

export interface LabServices {
  episodic: ToolContext["episodic"];
  dynamicTools: DynamicToolStore;
  reminders: ReminderService;
  watch: WatchService;
  obligations: ObligationStore;
  stop(): void;
}

/** Имена, которые в лаборатории ведут «внутрь» (для суда DNS навигации); остальное — публичный адрес-заглушка. */
const DEFAULT_DNS: Record<string, string[]> = { "localtest.me": ["127.0.0.1"], "127.0.0.1.nip.io": ["127.0.0.1"] };
const PUBLIC_STUB = "93.184.216.34";

/** Детерминированный DNS: реальный резолвер в лаборатории не зовём (сеть, флейк). */
export function labResolver(extra: Record<string, string[]> = {}): HostLookup {
  const table = { ...DEFAULT_DNS, ...extra };
  return async (host) => table[host.toLowerCase()] ?? [PUBLIC_STUB];
}

export function createLabServices(dir: string): LabServices {
  const reminders = new ReminderService(new ReminderStore(dir));
  // Проверка наблюдения без LLM: честно «не смогла» (transient), а не выдуманное met.
  const watch = new WatchService(async () => ({ met: false, summary: "", error: "лаборатория: LLM-проверка наблюдений не подключена", transient: true }), new WatchStore(dir));
  return {
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    dynamicTools: new DynamicToolStore(new Set(Object.keys(TOOLS_BY_NAME)), { storePath: `${dir}/dynamic-tools.json` }),
    reminders,
    watch,
    obligations: new ObligationStore(dir),
    stop() {
      reminders.stop();
      watch.stop();
    },
  };
}
