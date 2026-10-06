/**
 * Мелкие пробелы обязательств (найдено лабораторией): изоляция владельцев при снятии и дата «к ...» в часовых поясах западнее UTC.
 * Кейсы с ДЕФЕКТ - ожидание по закону; на текущем продукте красные (LAB_DEFECTS=1), в обычном прогоне пропущены.
 */
import { describe, it } from "vitest";
import { makeObligation } from "../../../apps/server/src/proactive/ambient/obligations.js";
import { obligationAdd } from "../../../apps/server/src/brain/tools/handlers/obligations.js";
import type { ToolContext } from "../../../apps/server/src/brain/tools/dispatch.js";
import { OWNER, useLab } from "./helpers.js";
import { DEFECTS, expect } from "./kit.js";
import type { ProactiveLab } from "./lab.js";

const ask = (lab: ProactiveLab): string => {
  const ctx = { obligations: lab.svc.obligations, userId: OWNER } as unknown as ToolContext;
  const r = obligationAdd(ctx, { what: "аренда", due: "2026-07-15" });
  return typeof r.content === "string" ? r.content : "";
};

describe("обязательства: владелец и даты", () => {
  const t = useLab({ start: "2026-07-01T10:00:00", tz: "Europe/Moscow" });

  it("чужой пользователь не снимает обязательство владельца по фрагменту текста", () => {
    const { lab } = t;
    lab.svc.obligations.add(makeObligation({ userId: OWNER, what: "аренда", dueAt: lab.clock.at("2026-07-15T12:00:00"), now: Date.now() })!);
    expect(lab.svc.obligations.cancel("аренда", "intruder")).toBeNull();
    expect(lab.svc.obligations.list(OWNER)).toHaveLength(1);
  });

  it.skipIf(!DEFECTS)("ДЕФЕКТ D9: чужой пользователь снимает обязательство владельца по эхнутому id (cancel по id без фильтра userId)", () => {
    const { lab } = t;
    const o = makeObligation({ userId: OWNER, what: "аренда", dueAt: lab.clock.at("2026-07-15T12:00:00"), now: Date.now() })!;
    lab.svc.obligations.add(o);
    expect(lab.svc.obligations.cancel(o.id, "intruder")).toBeNull(); // как reminders/watch (M12, L2)
    expect(lab.svc.obligations.list(OWNER)).toHaveLength(1);
  });

  it("due=«2026-07-15» в Москве подтверждается верной датой", () => {
    expect(ask(t.lab)).toContain("к 15.07.2026");
  });

  it.skipIf(!DEFECTS)("ДЕФЕКТ D10: due=«2026-07-15» в Нью-Йорке подтверждается как 14.07 (Date.parse даёт UTC-полночь, дата считается локально)", () => {
    const { lab } = t;
    lab.clock.setTz("America/New_York");
    expect(ask(lab)).toContain("к 15.07.2026");
  });
});
