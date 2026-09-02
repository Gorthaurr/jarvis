/**
 * /v1/admin/* — администрирование: пользователи, гранты планов/кредитов, стоп, purge, планы, отчёты,
 * sweep жизненного цикла подписок. Доступ — guards.authorizeAdmin (токен / роль / loopback без токена).
 */
import type { FastifyInstance } from "fastify";
import { query } from "../../db/pool.js";
import { getAccount, listUsers, setRole, setStatus } from "../accounts.js";
import { purgeDue, requestDeletion } from "../accounts-lifecycle.js";
import { grantCredits } from "../credits.js";
import { type Plan, listPlans, upsertPlan } from "../plans.js";
import { listReports, overviewReport, renderReportMarkdown, runReport } from "../reports/index.js";
import { effectivePlanFor, startSubscription, sweepLifecycle, transition } from "../subscriptions.js";
import { revokeAllForUser } from "../tokens-lifecycle.js";
import { type ProductRouteDeps, type RouteReply, type RouteRequest, body, params, queryOf, str } from "./deps.js";
import { authorizeAdmin, fail } from "./guards.js";

export function registerAdminRoutes(app: FastifyInstance, d: ProductRouteDeps): void {
  const admin = async (req: unknown, reply: RouteReply): Promise<boolean> => {
    const a = await authorizeAdmin(req as RouteRequest, d.policy, { exposed: d.exposed });
    if (!a.ok) {
      fail(reply, 403, "forbidden", a.message);
      return false;
    }
    return true;
  };

  app.get("/v1/admin/users", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const qs = queryOf(req as unknown as RouteRequest);
    const status = str(qs.status);
    const users = await listUsers({ limit: Number(qs.limit) || 100, offset: Number(qs.offset) || 0, ...(status ? { status: status as "active" | "blocked" | "deleted" } : {}) });
    return r.send({ ok: true, data: { users } });
  });

  app.get("/v1/admin/users/:id", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const id = str(params(req as unknown as RouteRequest).id);
    const acc = await getAccount(id);
    if (!acc) return fail(r, 404, "not_found", "пользователь не найден");
    const [eff, usage] = await Promise.all([effectivePlanFor(id, d.now()), d.usageInfo(id)]);
    return r.send({ ok: true, data: { account: acc, subscription: eff ? { planId: eff.plan.id, status: eff.status, periodEnd: new Date(eff.subscription.currentPeriodEnd).toISOString() } : null, usage } });
  });

  /** Выдать план (демо для друзей) и/или кредиты. Живая подписка на другой план → отменяется, новая стартует. */
  app.post("/v1/admin/users/:id/grant", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const id = str(params(req as unknown as RouteRequest).id);
    const b = body(req as unknown as RouteRequest);
    if (!(await getAccount(id))) return fail(r, 404, "not_found", "пользователь не найден");
    const out: Record<string, unknown> = {};
    const planId = str(b.planId);
    if (planId) {
      const live = await effectivePlanFor(id, d.now());
      if (live && live.plan.id !== planId) await transition(live.subscription.id, "canceled", {});
      const s = live && live.plan.id === planId ? { ok: true as const, subscription: live.subscription, trial: false } : await startSubscription({ userId: id, planId, source: "admin", now: d.now(), periodDays: Number(b.periodDays) || 30 });
      if (!s.ok) return fail(r, 409, s.reason, `план не выдан: ${s.reason}`);
      out.subscription = { id: s.subscription.id, planId: s.subscription.planId, status: s.subscription.status };
    }
    const credits = Number(b.creditsMicro);
    if (Number.isFinite(credits) && credits !== 0) {
      const g = await grantCredits({ userId: id, source: "admin", amountMicro: Math.round(credits), note: str(b.note) || undefined });
      out.grant = { id: g.id, amountMicro: g.amountMicro };
    }
    if (!planId && !(Number.isFinite(credits) && credits !== 0)) return fail(r, 400, "bad_request", "нужен planId и/или creditsMicro");
    await d.quota.applyTo(d.spend, id); // лимиты применяются сразу, без реконнекта пользователя
    return r.send({ ok: true, data: out });
  });

  app.post("/v1/admin/users/:id/kill", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const id = str(params(req as unknown as RouteRequest).id);
    const on = body(req as unknown as RouteRequest).on !== false;
    const g = d.spend.forUser(id);
    if (on) g.engageKillSwitch();
    else g.releaseKillSwitch();
    // Kill-switch — свойство ПОЛЬЗОВАТЕЛЯ, а не периода (контроль-ревью: стоп в сентябре после рестарта в октябре
    // не действовал): пишем во все строки usage_quota пользователя + upsert текущего периода.
    const period = new Date(d.now()).toISOString().slice(0, 7);
    await query("update usage_quota set kill_switch = $2, updated_at = now() where user_id = $1", [id, on]);
    await query("insert into usage_quota (user_id, period, kill_switch) values ($1,$2,$3) on conflict (user_id, period) do update set kill_switch = excluded.kill_switch, updated_at = now()", [id, period, on]);
    return r.send({ ok: true, data: { userId: id, killSwitch: on } });
  });

  app.post("/v1/admin/users/:id/role", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const role = str(body(req as unknown as RouteRequest).role);
    if (role !== "user" && role !== "admin") return fail(r, 400, "bad_request", "role: user|admin");
    return r.send({ ok: await setRole(str(params(req as unknown as RouteRequest).id), role) });
  });

  app.post("/v1/admin/users/:id/status", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const status = str(body(req as unknown as RouteRequest).status);
    if (status !== "active" && status !== "blocked") return fail(r, 400, "bad_request", "status: active|blocked (deleted — через purge)");
    const id = str(params(req as unknown as RouteRequest).id);
    const ok = await setStatus(id, status);
    // Блокировка — немедленно: живые access/refresh/device-токены отзываются (иначе заблокированный работал
    // бы до истечения токенов; WS-сессия закроется на следующем handshake).
    const revoked = ok && status === "blocked" ? await revokeAllForUser(id, undefined, { now: new Date(d.now()) }) : 0;
    return r.send({ ok, data: { status, revokedTokens: revoked } });
  });

  app.post("/v1/admin/users/:id/purge", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const id = str(params(req as unknown as RouteRequest).id);
    const res = await requestDeletion(id, { purgeAfterDays: 0, now: new Date(d.now()) });
    if (!res.ok) return fail(r, 404, res.reason, "не удалось");
    const purged = await purgeDue(new Date(d.now() + 1000));
    return r.send({ ok: true, data: { purged } });
  });

  app.get("/v1/admin/plans", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    return r.send({ ok: true, data: { plans: await listPlans({}) } });
  });

  app.post("/v1/admin/plans", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const p = body(req as unknown as RouteRequest) as unknown as Plan;
    if (!str(p.id) || !str(p.name)) return fail(r, 400, "bad_request", "нужны id и name плана");
    return r.send({ ok: true, data: { plan: await upsertPlan(p) } });
  });

  app.post("/v1/admin/sweep", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    return r.send({ ok: true, data: { transitions: await sweepLifecycle(d.now()) } });
  });

  app.get("/v1/admin/reports", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    return r.send({ ok: true, data: { reports: [{ name: "overview", title: "Сводка" }, ...listReports()] } });
  });

  app.get("/v1/admin/reports/:name", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(await admin(req, r))) return;
    const name = str(params(req as unknown as RouteRequest).name);
    const qs = queryOf(req as unknown as RouteRequest);
    const p = { now: d.now(), ...(qs.period ? { period: qs.period } : {}), ...(qs.days ? { days: Number(qs.days) } : {}), ...(qs.top ? { top: Number(qs.top) } : {}) };
    const report = name === "overview" ? await overviewReport(p) : await runReport(name, p);
    if (!report) return fail(r, 404, "not_found", "нет такого отчёта");
    if (qs.format === "md") return r.header("content-type", "text/markdown; charset=utf-8").send(renderReportMarkdown(report));
    return r.send({ ok: true, data: report });
  });
}
