/**
 * Учёт отсутствия расширения (ext-absence.ts + store) — поведение на фейковых часах и настоящем файле.
 *
 * Реверт-проверки (каждая роняет свой кейс):
 *  • не ограничивать разрыв тиков MAX_TICK_GAP (сон ПК идёт в счёт) → «простой между тиками не в счёт»;
 *  • считать тики при заблокированном экране → «ночь под блокировкой не в счёт»;
 *  • не гасить счётчики на подключении → «SW переподключается каждые 30 с»;
 *  • due() без reportedKind → «один раз до восстановления»; без эскалации → «мягкий не съедает уверенный»;
 *  • без санации файла → «чужие числа в файле»; троттлинг без учёта отката часов → «часы ушли назад».
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHROME_EVIDENCE_MS, ExtAbsence, SOFT_ABSENT_MS, STRONG_ABSENT_MS, isChromeProcess } from "./ext-absence.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const TICK = 15_000; // клиент шлёт client.context раз в 15 с

function setup(file = join(mkdtempSync(join(tmpdir(), "ext-absence-")), "ext-presence.json")) {
  const clock = { t: Date.UTC(2026, 8, 24, 18, 0) };
  const make = () => new ExtAbsence(() => file, () => clock.t);
  const tracker = make();
  /** Тики клиента в течение ms: активное приложение app, флаг моста connected, экран locked. */
  const run = (t: ExtAbsence, ms: number, app: string, connected = false, step = TICK, locked = false) => {
    for (let passed = 0; passed < ms; passed += step) {
      clock.t += step;
      t.tick(app, connected, locked);
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
    expect(tracker.due(false)).toMatchObject({ kind: "chrome", pinRejectedId: null });
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

  it("ночь под блокировкой экрана не в счёт (ПК включён, владельца нет)", () => {
    const { tracker, run } = setup();
    tracker.tick("explorer", false);
    run(tracker, 13 * HOUR, "explorer", false, TICK, true);
    expect(tracker.due(false)).toBeNull();
  });

  it("один раз до восстановления: сказали → молчим; подключилось → следующий провал снова доложим", () => {
    const { tracker, run } = setup();
    tracker.tick("chrome", false);
    run(tracker, STRONG_ABSENT_MS + CHROME_EVIDENCE_MS, "chrome");
    expect(tracker.due(false)).not.toBeNull();
    tracker.markReported("chrome");
    run(tracker, 15 * HOUR, "chrome");
    expect(tracker.due(false)).toBeNull();
    tracker.noteBridge(true); // расширение вернулось
    tracker.noteBridge(false);
    run(tracker, STRONG_ABSENT_MS + CHROME_EVIDENCE_MS, "chrome");
    expect(tracker.due(false)).toMatchObject({ kind: "chrome" });
  });

  it("мягкий доклад не съедает уверенный: после него появились улики Chrome → докладываем ещё раз (и только раз)", () => {
    const { tracker, run } = setup();
    tracker.tick("explorer", false);
    run(tracker, SOFT_ABSENT_MS + MIN, "explorer");
    tracker.markReported("unknown");
    run(tracker, 3 * HOUR, "explorer");
    expect(tracker.due(false)).toBeNull(); // улик не прибавилось — второй мягкий не нужен
    run(tracker, CHROME_EVIDENCE_MS + MIN, "chrome");
    expect(tracker.due(false)).toMatchObject({ kind: "chrome" });
    tracker.markReported("chrome");
    run(tracker, 5 * HOUR, "chrome");
    expect(tracker.due(false)).toBeNull();
  });

  it("отказ пиннингом = улика «Chrome открыт» и без переднего плана; подключение её гасит", () => {
    const { tracker, run } = setup();
    tracker.notePinRejected("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    tracker.tick("explorer", false);
    run(tracker, STRONG_ABSENT_MS + MIN, "explorer");
    expect(tracker.due(false)).toMatchObject({ kind: "chrome", pinRejectedId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    tracker.noteBridge(true);
    tracker.noteBridge(false);
    run(tracker, STRONG_ABSENT_MS + MIN, "explorer");
    expect(tracker.due(false)).toBeNull();
  });
});

describe("ExtAbsence: durable-состояние", () => {
  it("счётчики и флаг доклада переживают рестарт сервера (новый экземпляр на том же файле)", () => {
    const { tracker, run, make } = setup();
    tracker.tick("chrome", false);
    run(tracker, STRONG_ABSENT_MS + 5 * MIN, "chrome");
    expect(make().due(false)).toMatchObject({ kind: "chrome" });
    tracker.markReported("chrome");
    expect(make().due(false)).toBeNull();
  });

  it("битый файл → чистый учёт без исключения", () => {
    const { file, make } = setup();
    writeFileSync(file, "{not json", "utf8");
    const t = make();
    expect(t.due(false)).toBeNull();
    t.markReported("unknown");
    expect(JSON.parse(readFileSync(file, "utf8")).reportedKind).toBe("unknown");
  });

  it("чужие числа в файле санируются: дата вне разумного — «не знаю когда», счётчики — ноль", () => {
    const { file, make } = setup();
    writeFileSync(file, JSON.stringify({ lastSeenAt: 1e20, absentMs: 1e300, chromeMs: -5, reportedKind: "boom", pinRejectedId: "../../x" }), "utf8");
    const t = make();
    expect(t.due(false)).toBeNull(); // absentMs 1e300 не превратился в «пора докладывать»
    t.markReported("unknown");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ lastSeenAt: null, absentMs: 0, chromeMs: 0, pinRejectedId: null });
  });

  it("часы ушли назад (NTP) → запись не замирает на весь скачок", () => {
    const { tracker, run, make, clock } = setup();
    tracker.tick("chrome", false);
    run(tracker, 5 * MIN, "chrome");
    clock.t -= 3 * HOUR; // скачок больше всего дальнейшего наблюдения: без фикса запись молчала бы до конца теста
    run(tracker, STRONG_ABSENT_MS + 5 * MIN, "chrome");
    expect(make().due(false)).toMatchObject({ kind: "chrome" });
  });
});

it("isChromeProcess: имя процесса без учёта регистра и .exe; прочие браузеры и не-строки — нет", () => {
  expect(isChromeProcess("chrome")).toBe(true);
  expect(isChromeProcess("Chrome.exe")).toBe(true);
  expect(isChromeProcess("msedge")).toBe(false);
  expect(isChromeProcess(undefined)).toBe(false);
  expect(isChromeProcess(42)).toBe(false);
});
