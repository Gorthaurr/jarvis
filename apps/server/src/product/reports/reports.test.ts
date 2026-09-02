/**
 * Отчёты продукта против НАСТОЯЩЕГО Postgres (PGlite) с реальными миграциями (базовые + продуктовые).
 * Проверяем не «функция вернула объект», а ЧИСЛА: пользователи/подписки/ledger заведены руками, отчёты
 * обязаны их пересчитать точно; без БД — честное `available:false`, а не нули.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setQueryClientForTests, query } from "../../db/pool.js";
import { openProductTestDb } from "../test-db.js";
import { listReports, overviewReport, renderReport, runReport } from "./index.js";
import { renderReportMarkdown } from "./types.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0); // 2026-09-15
const PERIOD = "2026-09";

describe("отчёты продукта (PGlite)", () => {
  let close: () => Promise<void>;

  beforeAll(async () => {
    const h = await openProductTestDb();
    close = h.close;
    await query("insert into users (id, email_hash, role, status, created_at) values ($1, 'h1', 'user', 'active', $2)", [U1, new Date(NOW - 40 * 86_400_000).toISOString()]);
    await query("insert into users (id, email_hash, role, status, created_at) values ($1, 'h2', 'admin', 'active', $2)", [U2, new Date(NOW - 2 * 86_400_000).toISOString()]);
    await query(
      "insert into subscriptions (user_id, plan_id, status, current_period_start, current_period_end, source) values ($1, 'basic', 'active', $2, $3, 'admin')",
      [U1, new Date(NOW - 10 * 86_400_000).toISOString(), new Date(NOW + 20 * 86_400_000).toISOString()],
    );
    await query(
      "insert into subscriptions (user_id, plan_id, status, current_period_start, current_period_end, trial_end, source) values ($1, 'trial', 'trialing', $2, $3, $3, 'signup')",
      [U2, new Date(NOW - 2 * 86_400_000).toISOString(), new Date(NOW + 5 * 86_400_000).toISOString()],
    );
    // ledger: U1 — 3 вызова на 2 задачи в двух днях; U2 — 1 вызов
    const ins = (u: string, ts: number, task: string, model: string, micro: number) =>
      query("insert into usage_ledger (user_id, ts, period, task_id, round, kind, model, input_tokens, output_tokens, cost_micro, channel) values ($1,$2,$3,$4,1,'llm',$5,100,10,$6,'node')", [u, new Date(ts).toISOString(), PERIOD, task, model, micro]);
    await ins(U1, NOW - 86_400_000, "t1", "claude-sonnet-4-6", 50_000);
    await ins(U1, NOW - 86_400_000, "t1", "claude-sonnet-4-6", 70_000);
    await ins(U1, NOW - 3 * 86_400_000, "t2", "claude-opus-4-8", 200_000);
    await ins(U2, NOW - 3600_000, "t3", "claude-sonnet-4-6", 30_000);
    await query("insert into usage_quota (user_id, period, cost_micro, llm_quota_micro, warned_80_at) values ($1, $2, 320000, 400000, now())", [U1, PERIOD]);
    // оплата: инвойс + платёж U1 за basic
    const inv = await query<{ id: string }>("insert into invoices (user_id, plan_id, amount_minor, currency, status, provider, provider_ref, paid_at) values ($1,'basic',150000,'RUB','paid','fake','ref-1', now()) returning id", [U1]);
    await query("insert into payments (invoice_id, provider, provider_payment_id, amount_minor, currency, status) values ($1,'fake','pay-1',150000,'RUB','succeeded')", [inv?.rows[0]?.id]);
  });

  afterAll(async () => {
    await close();
  });

  // Сид 0002 заводит DEV_USER (created_at = момент миграции, т.е. «сегодня») → он третий и «новый».
  it("users: считает всего/новых/активных по ledger/удалённых (с учётом DEV_USER из сида)", async () => {
    const r = await runReport("users", { now: NOW });
    expect(r?.available).toBe(true);
    expect(r?.kpi["всего"]).toBe(3);
    expect(r?.kpi["новых за 30 дн"]).toBe(2); // U2 + DEV_USER; U1 старше 30 дн
    expect(r?.kpi["активных за 7 дн (были вызовы)"]).toBe(2); // у DEV_USER вызовов нет
    expect(r?.kpi["удалённых"]).toBe(0);
  });

  it("subscriptions: MRR по живым месячным планам, истекающие триалы", async () => {
    const r = await runReport("subscriptions", { now: NOW });
    expect(r?.available).toBe(true);
    expect(r?.kpi["MRR (RUB)"]).toBe(0); // basic выдан админом (source=admin) — не выручка; триал 0 ₽
    expect(r?.kpi["выдано бесплатно, эквивалент (RUB)"]).toBe(1500);
    expect(r?.kpi["живых подписок"]).toBe(2);
    expect(r?.kpi["триалов истекает за 7 дн"]).toBe(1);
  });

  it("usage: COGS по ledger точен до микро-доллара, маржа по цене плана", async () => {
    const r = await runReport("usage", { period: PERIOD, now: NOW });
    expect(r?.available).toBe(true);
    expect(r?.kpi["COGS всего, $"]).toBeCloseTo(0.35, 6); // 50000+70000+200000+30000 µ$
    expect(r?.kpi["вызовов"]).toBe(4);
    const top = r?.tables[0]?.rows[0];
    expect(top?.[0]).toBe(U1);
    expect(top?.[2]).toBe(2); // задач
    expect(top?.[5]).toBeCloseTo(0.32, 6); // COGS U1
  });

  it("models: доля по моделям суммируется в 100%", async () => {
    const r = await runReport("models", { period: PERIOD, now: NOW });
    expect(r?.available).toBe(true);
    const shares = (r?.tables[0]?.rows ?? []).map((row) => Number(row[5]));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    expect(r?.tables[0]?.rows.find((row) => row[0] === "claude-opus-4-8")?.[5]).toBeCloseTo(57.1, 0);
  });

  it("quota: у потолка ≥80% — U1 (320000 из 400000)", async () => {
    const r = await runReport("quota", { period: PERIOD, now: NOW });
    expect(r?.kpi["у потолка (≥80%)"]).toBe(1);
    expect(r?.kpi["исчерпали (≥100%)"]).toBe(0);
  });

  it("revenue: оплачено 1500 ₽, нетто 1500", async () => {
    const r = await runReport("revenue", { now: NOW });
    expect(r?.kpi["оплачено (осн. ед.)"]).toBe(1500);
    expect(r?.kpi["нетто"]).toBe(1500);
  });

  it("retention + data + overview + markdown", async () => {
    const ret = await runReport("retention", { now: NOW });
    expect(ret?.kpi["активных пользователей"]).toBe(2);
    const data = await runReport("data", { now: NOW });
    expect(data?.available).toBe(true);
    expect(data?.tables[0]?.rows.find((row) => row[0] === "users")?.[1]).toBe(3);
    const ov = await overviewReport({ now: NOW, period: PERIOD });
    expect(ov.available).toBe(true);
    expect(ov.kpi["Пользователи · всего"]).toBe(3);
    const md = await renderReport("usage", { period: PERIOD, now: NOW });
    expect(md).toContain("# Расход и COGS");
    expect(md).toContain("| userId |");
    expect(listReports().map((x) => x.name)).toContain("revenue");
    expect(await runReport("nope")).toBeNull();
  });

  it("без БД — честное available:false, не нули", async () => {
    __setQueryClientForTests(null);
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const r = await runReport("users", { now: NOW });
      expect(r?.available).toBe(false);
      expect(r?.reason).toContain("БД");
      expect(renderReportMarkdown(r!)).toContain("Недоступен");
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
