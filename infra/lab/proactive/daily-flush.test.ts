/**
 * Суточные проактивные доклады на виртуальных часах и НАСТОЯЩИХ сторах: сводка о ночных сбоях (incidents), брифинг дня,
 * самоосмотр, суточный слот консолидации. Проводка router-ws (триггер «первая реплика владельца») проверяется живьём в live.test.ts.
 */
import { describe, it } from "vitest";
import { claimConsolidationRun } from "../../../apps/server/src/proactive/consolidation.js";
import { buildBriefing, shouldBrief } from "../../../apps/server/src/proactive/briefing.js";
import { readUnreportedIncidents, recordIncident, takeIncidentReport } from "../../../apps/server/src/proactive/incidents.js";
import { makeObligation, upcomingDue } from "../../../apps/server/src/proactive/ambient/obligations.js";
import { shouldSelfReview } from "../../../apps/server/src/proactive/self-review.js";
import { OWNER, remindAt, useLab, watch } from "./helpers.js";
import { expect } from "./kit.js";
import type { ProactiveLab } from "./lab.js";

const DAY = 86_400_000;

describe("доклад о ночных сбоях", () => {
  const t = useLab({ start: "2026-07-29T01:00:00", tz: "Europe/Moscow" });

  it("один сбой: точная фраза с местным временем, повторный доклад пуст (маркер сдвинут только при взятии)", async () => {
    const { lab } = t;
    await lab.clock.advanceTo("2026-07-29T03:00:00");
    recordIncident("crash", "Сервер упал и поднялся сам");
    await lab.clock.advanceTo("2026-07-29T08:00:00");
    expect(readUnreportedIncidents()).toHaveLength(1); // просмотр маркер не двигает
    expect(takeIncidentReport()).toBe("Небольшой доклад, сэр: Сервер упал и поднялся сам — это было в 3:00. Сейчас всё работает.");
    expect(takeIncidentReport()).toBeNull();
  });

  it("несколько сбоев сводятся в ОДНУ фразу со счётом и временем последнего", async () => {
    const { lab } = t;
    await lab.clock.advanceTo("2026-07-29T03:00:00");
    recordIncident("crash", "упал");
    await lab.clock.advanceTo("2026-07-29T05:30:00");
    recordIncident("crash", "упал снова");
    await lab.clock.advanceTo("2026-07-29T08:00:00");
    expect(takeIncidentReport()).toBe("Небольшой доклад, сэр: пока вас не было, я был недоступен и восстанавливался сам — 2 раза, последний раз в 5:30. Сейчас всё работает.");
  });

  it("сбой старше суток не докладывается (маркер всё равно сдвигается), новый - докладывается один", async () => {
    const { lab } = t;
    await lab.clock.advanceTo("2026-07-29T03:00:00");
    recordIncident("crash", "старый сбой");
    await lab.clock.advanceTo("2026-07-30T04:00:00"); // прошло 25 часов
    expect(takeIncidentReport()).toBeNull();
    await lab.clock.advanceTo("2026-07-30T04:10:00");
    recordIncident("crash", "свежий сбой");
    const line = takeIncidentReport() ?? "";
    expect(line).toContain("свежий сбой");
    expect(line).not.toContain("старый");
  });
});

describe("брифинг дня", () => {
  const t = useLab({ start: "2026-07-29T08:00:00", tz: "Europe/Moscow" });
  /** Сборка входа как в gateway/router-ws.ts:582-591 - проекции живых сервисов стенда. */
  const brief = (lab: ProactiveLab): string | null => {
    const now = Date.now();
    return buildBriefing({
      reminders: lab.svc.reminders.list(OWNER).map((r) => ({ fireAt: r.fireAt, text: r.text })),
      obligations: lab.svc.obligations.list(OWNER).map((o) => ({ dueAt: upcomingDue(o, now)!, title: o.what })),
      watches: lab.svc.watch.list({ userId: OWNER }).map((w) => ({ what: w.what })),
    }, now);
  };

  it("пустой день - молчание (null), а не вежливая пустота", () => {
    expect(brief(t.lab)).toBeNull();
  });

  it("сводка из живых сервисов: напоминание сегодня, счёт завтра, слежу за; завтрашнее напоминание в «сегодня» не попадает", () => {
    const { lab } = t;
    remindAt(lab, "Созвон с командой", "2026-07-29T14:00:00");
    remindAt(lab, "Завтрашнее дело", "2026-07-30T09:00:00");
    lab.svc.obligations.add(makeObligation({ userId: OWNER, what: "аренда", dueAt: lab.clock.at("2026-07-30T12:00:00"), now: Date.now() })!);
    watch(lab, { what: "курс биткоина" });
    const line = brief(lab) ?? "";
    expect(line).toContain("На сегодня: в 14:00 — Созвон с командой");
    expect(line).not.toContain("Завтрашнее дело");
    expect(line).toContain("Сроки: аренда — завтра");
    expect(line).toContain("Слежу за: курс биткоина");
  });

  it("просроченный счёт назван просроченным, а не «завтра»", () => {
    const { lab } = t;
    lab.svc.obligations.add(makeObligation({ userId: OWNER, what: "аренда", dueAt: lab.clock.at("2026-07-27T12:00:00"), now: Date.now() })!);
    expect(brief(lab)).toContain("аренда — срок уже прошёл");
  });

  it("гейт «раз в календарный день» пересекает полночь по местным часам, а не по 24 часам", () => {
    const { lab } = t;
    const late = lab.clock.at("2026-07-29T23:59:00");
    expect(shouldBrief({ lastBriefedAt: late }, lab.clock.at("2026-07-29T23:59:50"))).toBe(false);
    expect(shouldBrief({ lastBriefedAt: late }, lab.clock.at("2026-07-30T00:01:00"))).toBe(true); // 2 минуты, но уже новый день
    expect(shouldBrief({ lastBriefedAt: lab.clock.at("2026-07-29T00:01:00") }, lab.clock.at("2026-07-29T23:59:00"))).toBe(false); // 24 часа без минуты, но тот же день
  });
});

describe("самоосмотр и сон-цикл: суточные слоты", () => {
  const t = useLab({ start: "2026-07-29T08:00:00", tz: "Europe/Moscow" });

  it("самоосмотр раз в 3 суток: через 2 суток нет, через 3 - да; выключатель сильнее", () => {
    const now = Date.now();
    const gate = (ago: number, enabled = true) => shouldSelfReview({ lastReviewedAt: now - ago, everyDays: 3, enabled }, now);
    expect(gate(2 * DAY)).toBe(false);
    expect(gate(3 * DAY)).toBe(true);
    expect(gate(9 * DAY, false)).toBe(false);
  });

  it("сон-цикл: слот на календарный день бронируется один раз, после местной полуночи - снова", async () => {
    const { lab } = t;
    await lab.clock.advanceTo("2026-07-29T23:59:00");
    const today = (): string => new Date().toDateString();
    expect(claimConsolidationRun("u-slot", today())).toBe(true);
    expect(claimConsolidationRun("u-slot", today())).toBe(false);
    await lab.clock.advance(2 * 60_000); // 00:01 30 июля
    expect(claimConsolidationRun("u-slot", today())).toBe(true);
  });
});
