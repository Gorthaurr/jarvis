/**
 * Ledger против реальной схемы: сумма строк == агрегат usage_quota.cost_micro == ledgerSummary; всё целое;
 * период по UTC; топ задач; невалидная стоимость не пишется.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../db/pool.js";
import { ensureUser } from "../db/users.js";
import { costMicroUsd } from "../obs/pricing.js";
import { ProductError } from "./db.js";
import { ledgerSummary, periodOf, recordLedger, topTasks } from "./ledger.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";

const T0 = Date.UTC(2026, 8, 2, 12);
const U = (n: number): string => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("product/ledger (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("periodOf — 'YYYY-MM' по UTC (как SpendGuard.currentPeriod)", () => {
    expect(periodOf(T0)).toBe("2026-09");
    expect(periodOf(Date.UTC(2026, 11, 31, 23, 59))).toBe("2026-12");
  });

  it("сумма записей == агрегат usage_quota == ledgerSummary; микро-доллары целые", async () => {
    await ensureUser(U(1));
    const usage = { inputTokens: 2279, outputTokens: 146, cacheReadTokens: 36327, cacheCreationTokens: 4921 };
    const c1 = costMicroUsd("claude-sonnet-4-6", usage, { cacheTtl: "1h" });
    const c2 = costMicroUsd("claude-opus-4-8", { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 }, { cacheTtl: "1h" });
    expect(Number.isInteger(c1) && Number.isInteger(c2)).toBe(true);
    await recordLedger({ userId: U(1), ts: T0, taskId: "t1", round: 1, kind: "llm", model: "claude-sonnet-4-6", usage, costMicro: c1, channel: "node", ok: true });
    await recordLedger({ userId: U(1), ts: T0 + 1000, taskId: "t1", round: 2, kind: "llm", model: "claude-opus-4-8", usage: { inputTokens: 1000, outputTokens: 500 }, costMicro: c2, channel: "node" });
    await recordLedger({ userId: U(1), ts: T0 + 2000, taskId: "t2", kind: "tts", ttsChars: 120, costMicro: 216, channel: "node" });
    await recordLedger({ userId: U(1), ts: T0 + 3000, kind: "stt", sttSeconds: 4.5, costMicro: 435, channel: "proxy", estimated: true });
    const s = await ledgerSummary(U(1), "2026-09");
    expect(s.costMicro).toBe(c1 + c2 + 216 + 435);
    expect(s.calls).toBe(4);
    expect(s.byModel.find((m) => m.model === "claude-sonnet-4-6")?.costMicro).toBe(c1);
    expect(s.byModel.find((m) => m.model === "claude-opus-4-8")?.costMicro).toBe(c2);
    expect(s.byKind.map((k) => k.kind).sort()).toEqual(["llm", "stt", "tts"]);
    const agg = await query<{ cost_micro: unknown; tokens_used: unknown; tts_chars_used: unknown }>("select cost_micro, tokens_used, tts_chars_used from usage_quota where user_id = $1 and period = '2026-09'", [U(1)]);
    expect(Number(agg?.rows[0]?.cost_micro)).toBe(s.costMicro);
    // tokens_used в usage_quota ведёт SpendGuard.persistUsage (тот же вызов петли) — ledger его НЕ трогает,
    // иначе двойной счёт; здесь SpendGuard не участвовал → 0. Токены per-round лежат в самом ledger.
    expect(Number(agg?.rows[0]?.tokens_used)).toBe(0);
    expect(Number(agg?.rows[0]?.tts_chars_used)).toBe(120);
    const raw = await query<{ total: unknown; n: unknown }>("select sum(cost_micro) as total, count(*)::int as n from usage_ledger where user_id = $1", [U(1)]);
    expect(Number(raw?.rows[0]?.total)).toBe(s.costMicro);
    expect(Number(raw?.rows[0]?.n)).toBe(4);
    expect(Number.isInteger(s.costMicro)).toBe(true);
  });

  it("topTasks — по убыванию стоимости, без строк без task_id; другой период пуст", async () => {
    const top = await topTasks(U(1), "2026-09", 5);
    expect(top.map((t) => t.taskId)).toEqual(["t1", "t2"]);
    expect(top[0]?.calls).toBe(2);
    expect(top[0]?.firstTs).toBe(T0);
    expect(top[0]?.lastTs).toBe(T0 + 1000);
    expect(await topTasks(U(1), "2026-10", 5)).toEqual([]);
    expect((await ledgerSummary(U(1), "2026-10")).calls).toBe(0);
  });

  it("дробная стоимость округляется до целого µ$; NaN/отрицательная → ошибка, строки нет", async () => {
    await ensureUser(U(2));
    await recordLedger({ userId: U(2), ts: T0, kind: "llm", costMicro: 12.6, channel: "brain" });
    expect((await ledgerSummary(U(2), "2026-09")).costMicro).toBe(13);
    await expect(recordLedger({ userId: U(2), ts: T0, kind: "llm", costMicro: Number.NaN, channel: "node" })).rejects.toBeInstanceOf(ProductError);
    await expect(recordLedger({ userId: U(2), ts: T0, kind: "llm", costMicro: -1, channel: "node" })).rejects.toThrow(/costMicro/);
    expect((await ledgerSummary(U(2), "2026-09")).calls).toBe(1);
  });
});
