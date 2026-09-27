/**
 * Учёт отсутствия расширения (ext-absence.ts) — поведение на фейковых часах и настоящем файле.
 *
 * Реверт-проверки (каждая роняет свой кейс):
 *  • не ограничивать разрыв тиков MAX_TICK_GAP (сон ПК идёт в счёт) → «простой между тиками не в счёт»;
 *  • не гасить счётчики на подключении → «SW переподключается каждые 30 с»;
 *  • не проверять reportedAt в due() → «один раз до восстановления»;
 *  • detach-обёртка без проверки перехода → «чужой сокет не освежает lastSeenAt».
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionBridge } from "./extension-bridge.js";
import { CHROME_EVIDENCE_MS, ExtAbsence, STRONG_ABSENT_MS, isChromeProcess } from "./ext-absence.js";
import { trackExtPresence } from "./ext-absence-seam.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const TICK = 15_000; // клиент шлёт client.context раз в 15 с

function setup(file = join(mkdtempSync(join(tmpdir(), "ext-absence-")), "ext-presence.json")) {
  const clock = { t: Date.UTC(2026, 8, 24, 18, 0) };
  const make = () => new ExtAbsence(() => file, () => clock.t);
  const tracker = make();
  /** Тики клиента в течение ms: активное приложение app, флаг моста connected. */
  const run = (t: ExtAbsence, ms: number, app: string, connected = false, step = TICK) => {
    for (let passed = 0; passed < ms; passed += step) {
      clock.t += step;
      t.tick(app, connected);
    }
  };
  return { file, clock, make, tracker, run };
}

describe("ExtAbsence: когда докладывать", () => {
  it("Chrome на переднем плане, расширения нет ≥ 2 ч → уверенный доклад; раньше — молчим", () => {
    const { tracker, run } = setup();
    tracker.tick("chrome", false); // первый тик — точка отсчёта
    run(tracker, STRONG_ABSENT_MS - 5 * MIN, "chrome");
    expect(tracker.due(false)).toBeNull();
    run(tracker, 10 * MIN, "chrome");
    expect(tracker.due(false)).toMatchObject({ kind: "chrome" });
    expect(tracker.due(true)).toBeNull(); // живой флаг моста главнее счётчиков
  });

  it("Chrome закрыт (другие программы) → не тревожим 11 ч; к 12 ч — мягкий доклад", () => {
    const { tracker, run } = setup();
    tracker.tick("explorer", false);
    run(tracker, 11 * HOUR, "explorer");
    expect(tracker.due(false)).toBeNull();
    run(tracker, 1 * HOUR + MIN, "Code");
    expect(tracker.due(false)).toMatchObject({ kind: "unknown" });
  });

  it("SW переподключается каждые 30 с (будильник MV3) → никогда не докладываем", () => {
    const { tracker, run } = setup();
    for (let i = 0; i < 13 * 60 * 2; i++) {
      run(tracker, 30_000, "chrome", false);
      tracker.tick("chrome", true); // коннект по будильнику
    }
    expect(tracker.due(false)).toBeNull();
  });

  it("простой между тиками (ПК спал, клиент лежал) не в счёт", () => {
    const { tracker, run } = setup();
    tracker.tick("chrome", false);
    run(tracker, 13 * HOUR, "chrome", false, 2 * HOUR); // тик раз в 2 ч — это разрывы, не наблюдение
    expect(tracker.due(false)).toBeNull();
  });

  it("один раз до восстановления: сказали → молчим; подключилось → следующий провал снова доложим", () => {
    const { tracker, run } = setup();
    tracker.tick("chrome", false);
    run(tracker, STRONG_ABSENT_MS + CHROME_EVIDENCE_MS, "chrome");
    expect(tracker.due(false)).not.toBeNull();
    tracker.markReported();
    run(tracker, 5 * HOUR, "chrome");
    expect(tracker.due(false)).toBeNull();
    tracker.noteBridge(true); // расширение вернулось
    tracker.noteBridge(false);
    run(tracker, STRONG_ABSENT_MS + CHROME_EVIDENCE_MS, "chrome");
    expect(tracker.due(false)).toMatchObject({ kind: "chrome" });
  });
});

describe("ExtAbsence: durable-состояние", () => {
  it("счётчики и флаг доклада переживают рестарт сервера (новый экземпляр на том же файле)", () => {
    const { tracker, run, make } = setup();
    tracker.tick("chrome", false);
    run(tracker, STRONG_ABSENT_MS + 5 * MIN, "chrome");
    expect(make().due(false)).toMatchObject({ kind: "chrome" });
    tracker.markReported();
    expect(make().due(false)).toBeNull();
  });

  it("битый файл → чистый учёт без исключения", () => {
    const { file, make } = setup();
    writeFileSync(file, "{not json", "utf8");
    const t = make();
    expect(t.due(false)).toBeNull();
    t.markReported();
    expect(JSON.parse(readFileSync(file, "utf8")).reportedAt).toEqual(expect.any(Number));
  });
});

describe("trackExtPresence: lastSeenAt — события моста", () => {
  const sock = () => ({ send: () => undefined, close: () => undefined });

  it("detach живого расширения фиксирует момент потери даже без тиков клиента", () => {
    const { tracker, clock, run } = setup();
    const bridge = new ExtensionBridge();
    const routes = trackExtPresence(bridge, () => tracker);
    const s = sock();
    routes.attach(s);
    clock.t += 3 * HOUR; // клиент лежал — тиков нет
    const lostAt = clock.t;
    routes.detach(s);
    tracker.tick("chrome", false);
    run(tracker, STRONG_ABSENT_MS + CHROME_EVIDENCE_MS, "chrome");
    expect(tracker.due(false)?.lastSeenAt).toBe(lostAt);
  });

  it("error недопущенного сокета (мост его игнорирует) не освежает lastSeenAt отсутствующего расширения", () => {
    const { tracker, clock, run } = setup();
    const bridge = new ExtensionBridge();
    const routes = trackExtPresence(bridge, () => tracker);
    const s = sock();
    routes.attach(s);
    const lostAt = clock.t;
    routes.detach(s);
    clock.t += HOUR;
    routes.detach(sock()); // самозванец/отклонённый упал с error до допуска
    tracker.tick("chrome", false);
    run(tracker, STRONG_ABSENT_MS + CHROME_EVIDENCE_MS, "chrome");
    expect(tracker.due(false)?.lastSeenAt).toBe(lostAt);
  });
});

it("isChromeProcess: имя процесса без учёта регистра и .exe; прочие браузеры — нет", () => {
  expect(isChromeProcess("chrome")).toBe(true);
  expect(isChromeProcess("Chrome.exe")).toBe(true);
  expect(isChromeProcess("msedge")).toBe(false);
  expect(isChromeProcess(undefined)).toBe(false);
});
