/**
 * Шов моста /ext → учёт отсутствия (trackExtPresence) на НАСТОЯЩЕМ ExtensionBridge.
 *
 * Реверт-проверки: detach-обёртка без проверки перехода → «error недопущенного сокета»; `rejected` без проверки
 * «нашего нет на связи» → «отказ самозванцу при живом расширении»; lastSeenAt только тиками → «detach без тиков».
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionBridge } from "./extension-bridge.js";
import { CHROME_EVIDENCE_MS, ExtAbsence, STRONG_ABSENT_MS } from "./ext-absence.js";
import { trackExtPresence } from "./ext-absence-seam.js";
import { JARVIS_WEB_HANDS_EXT_ID as OURS } from "./ext-id.js";

const HOUR = 3_600_000;
const OTHER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function setup() {
  const clock = { t: Date.UTC(2026, 8, 24, 18, 0) };
  const tracker = new ExtAbsence(() => join(mkdtempSync(join(tmpdir(), "ext-seam-")), "ext-presence.json"), () => clock.t);
  const bridge = new ExtensionBridge();
  const routes = trackExtPresence(bridge, () => tracker);
  /** Владелец за ПК ms, на переднем плане app, расширения нет. */
  const observe = (ms: number, app = "chrome") => {
    tracker.tick(app, false);
    for (let passed = 0; passed < ms; passed += 15_000) {
      clock.t += 15_000;
      tracker.tick(app, false);
    }
  };
  const sock = () => ({ send: () => undefined, close: () => undefined });
  return { clock, tracker, routes, observe, sock };
}

describe("trackExtPresence: события моста → учёт", () => {
  it("detach живого расширения фиксирует момент потери даже без тиков клиента", () => {
    const { tracker, clock, routes, observe, sock } = setup();
    const s = sock();
    routes.attach(s);
    clock.t += 3 * HOUR; // клиент лежал — тиков нет
    const lostAt = clock.t;
    routes.detach(s);
    observe(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    expect(tracker.due(false)?.lastSeenAt).toBe(lostAt);
  });

  it("error недопущенного сокета (мост его игнорирует) не освежает lastSeenAt отсутствующего расширения", () => {
    const { tracker, clock, routes, observe, sock } = setup();
    const s = sock();
    routes.attach(s);
    const lostAt = clock.t;
    routes.detach(s);
    clock.t += HOUR;
    routes.detach(sock()); // самозванец/отклонённый упал с error до допуска
    observe(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    expect(tracker.due(false)?.lastSeenAt).toBe(lostAt);
  });

  it("отказ пиннингом НАШЕГО ID, пока нас нет, — улика для доклада; чужой ID — нет", () => {
    const { tracker, routes, observe } = setup();
    routes.rejected?.(OTHER_ID);
    observe(STRONG_ABSENT_MS + HOUR / 60, "explorer");
    expect(tracker.due(false)).toBeNull();
    routes.rejected?.(OURS);
    expect(tracker.due(false)).toMatchObject({ kind: "chrome", pinRejectedId: OURS });
  });

  it("отказ самозванцу при ЖИВОМ расширении не оставляет улики на будущий провал", () => {
    const { tracker, routes, observe, sock } = setup();
    const s = sock();
    routes.attach(s);
    routes.rejected?.(OURS); // подделка нашего Origin при живом расширении (S-12 держит канал)
    routes.detach(s); // Chrome закрыли вечером
    observe(STRONG_ABSENT_MS + HOUR / 60, "explorer");
    expect(tracker.due(false)).toBeNull(); // без улики — только мягкий порог (12 ч), до него молчим
  });
});
