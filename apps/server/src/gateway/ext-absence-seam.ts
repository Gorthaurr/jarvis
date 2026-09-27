/**
 * ШВЫ учёта отсутствия расширения (ext-absence.ts) в раздутые файлы шлюза — по одной строке на место:
 *  • server.ts: мост на маршруте /ext обёрнут `trackExtPresence` (события attach/detach → lastSeenAt);
 *  • router-ws `client.context`: `tickExtAbsence` (наблюдённое время, Chrome на переднем плане);
 *  • router-ws `onOwnerPresent`: `flushExtAbsenceForOwner` — доклад владельцу (ext-absence-report.ts).
 */
import { createLogger } from "@jarvis/shared";
import { verbalize } from "../brain/verbalize/index.js";
import { type ExtAbsence, extAbsence } from "./ext-absence.js";
import { flushExtAbsence } from "./ext-absence-report.js";
import type { ExtBridgeLike } from "./ws-routes.js";

const log = createLogger("ext-absence");

/** Обёртка моста для маршрута /ext: после attach/detach сообщает трекеру ФАКТИЧЕСКОЕ состояние моста. */
export function trackExtPresence(bridge: ExtBridgeLike & { readonly connected: boolean }, tracker: () => ExtAbsence = extAbsence): ExtBridgeLike {
  return {
    attach: (sock) => {
      bridge.attach(sock);
      tracker().noteBridge(bridge.connected);
    },
    detach: (sock) => {
      // Только настоящий переход «было на связи → нет»: detach зовётся и на `error` НЕдопущенного сокета
      // (мост его игнорирует) — без этой проверки чужой сокет «освежал» бы lastSeenAt отсутствующего расширения.
      const was = bridge.connected;
      bridge.detach(sock);
      if (was && !bridge.connected) tracker().noteBridge(false);
    },
    handleMessage: (text) => bridge.handleMessage(text),
  };
}

/** Тик `client.context`. Dev-сессия (текст-драйвер) — не наблюдение за ПК владельца. */
export function tickExtAbsence(devSession: boolean | undefined, activeApp: string | undefined, connected: boolean): void {
  if (!devSession) extAbsence().tick(activeApp, connected);
}

export interface OwnerChannel {
  /** Пропустить: dev-сессия или продуктовый режим (Chrome — владельца машины, не арендатора). */
  skip: boolean;
  connected: boolean;
  busy: boolean;
  voice: { speakQueued(text: string): void };
  session: { send(type: "chat", payload: { role: "assistant"; text: string }): void };
}

/** Реплика владельца: пора — сказать голосом (verbalize) и копией в чат. Сбой — только WARN (ход не страдает). */
export function flushExtAbsenceForOwner(o: OwnerChannel): void {
  if (o.skip) return;
  try {
    flushExtAbsence({
      tracker: extAbsence(),
      connected: o.connected,
      ownerBusy: o.busy,
      speak: (t) => o.voice.speakQueued(verbalize(t)),
      chat: (t) => o.session.send("chat", { role: "assistant", text: t }),
    });
  } catch (e) {
    log.warn("доклад об отсутствии расширения не удался", e instanceof Error ? e.message : String(e));
  }
}
