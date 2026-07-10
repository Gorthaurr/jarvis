/**
 * Хендлеры ИНФО-доменов (§) — вынесено из god-object dispatch.ts (§ревью).
 * web_search/web_fetch (веб), knowledge_consult (база знаний), memory_search (эпизодическая память).
 * Результаты внешних источников — `untrusted()` (граница данные/инструкции). Маршрутизация — в dispatch (switch).
 */
import { memoryMinScore } from "../../../memory/episodic.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, numField, ok, untrusted } from "../dispatch-util.js";

export async function webSearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input.query ?? "").trim();
  if (!q) return err("web_search: пустой query");
  // Схема инструмента (§12) объявляет поле `count`; принимаем и `limit` для совместимости.
  const limit = numField(input, ["count", "limit"], 5);
  const hits = await ctx.web.search(q, limit);
  if (hits.length === 0) return ok("Ничего не найдено (или web-провайдер в стаб-режиме).");
  return untrusted("веб-поиск", hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"));
}

export async function webFetch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input.url ?? "").trim();
  if (!url) return err("web_fetch: пустой url");
  const page = await ctx.web.fetch(url);
  if (!page) return err("Не удалось загрузить страницу.");
  // Схема инструмента (§12) объявляет maxChars — honor'им, если задан.
  const max = numField(input, ["maxChars"], 0);
  const text = max > 0 ? page.text.slice(0, max) : page.text;
  return untrusted(`веб-страница ${url}`, `# ${page.title}\n${text}`);
}

export async function knowledgeConsult(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.knowledge) return err("База знаний недоступна (не сконфигурирована).");
  const domain = String(input.domain ?? "").trim().toLowerCase();
  const query = String(input.query ?? "").trim();
  if (!domain) return err(`knowledge_consult: укажи domain. Доступно: ${ctx.knowledge.domains().join(", ") || "—"}.`);
  const r = ctx.knowledge.consult(domain, query);
  if (!r.found) return err(`Нет домена «${domain}». Доступно: ${ctx.knowledge.domains().join(", ") || "—"}.`);
  // Знание — ДАННЫЕ для рассуждения (не команды): помечаем как недоверенный контент (§безопасность).
  return untrusted(`база знаний: ${domain}`, `${r.text}\n\n[разделы: ${r.topics.join(" · ")}]`);
}

export async function memorySearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input.query ?? "").trim();
  if (!q) return err("memory_search: пустой query");
  // Схема инструмента (§8) объявляет `topK`; принимаем и `k` для совместимости. Клампим к целому
  // 1..50: значение приходит от LLM, дробное/отрицательное роняет SQL LIMIT → тихий пустой результат.
  const k = Math.max(1, Math.min(50, Math.floor(numField(input, ["topK", "k"], 5))));
  const hits = await ctx.episodic.search(ctx.userId, q, k, memoryMinScore());
  if (hits.length === 0) return ok("В памяти ничего релевантного не найдено.");
  return ok(hits.map((h) => `- ${h.episode.text} (${h.score.toFixed(2)})`).join("\n"));
}
